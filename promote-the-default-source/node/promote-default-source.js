/**
 * Promote a customer's default Source to a matching PaymentMethod.
 *
 * A customer whose default payment is still a legacy Source cannot be
 * charged off session under SCA. This walks customers behind active or on
 * hold subscriptions, finds anyone whose Stripe default is a Source, looks
 * for an attached PaymentMethod with a matching card fingerprint, and
 * promotes it to invoice_settings.default_payment_method. Read only by
 * default. Safe to run again and again, since a customer already on a
 * PaymentMethod is skipped.
 *
 * Guide: https://www.allanninal.dev/woocommerce/promote-the-default-source/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function metaValue(obj, key) {
  return (obj.meta_data || []).find((m) => m.key === key)?.value ?? null;
}

async function* activeSubscriptionCustomers() {
  const seen = new Set();
  let page = 1;
  while (true) {
    const res = await fetch(
      `${WOO_URL}/wp-json/wc/v3/subscriptions?status=active,on-hold&per_page=50&page=${page}`,
      { headers: { Authorization: AUTH } }
    );
    if (!res.ok) throw new Error(`Woo subscriptions returned ${res.status}`);
    const batch = await res.json();
    if (!batch.length) return;
    for (const sub of batch) {
      const customerId = metaValue(sub, "_stripe_customer_id");
      if (customerId && !seen.has(customerId)) {
        seen.add(customerId);
        yield customerId;
      }
    }
    page++;
  }
}

async function loadCustomerState(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  const methods = await stripe.paymentMethods.list({ customer: customerId, type: "card" });
  return { customer, methods: methods.data };
}

async function sourceFingerprint(sourceId) {
  if (!sourceId || !sourceId.startsWith("src_")) return null;
  const source = await stripe.sources.retrieve(sourceId);
  return source.card?.fingerprint || null;
}

/**
 * Pure decision: what to do about a customer's current default payment.
 *
 * Returns a tuple of [action, detail]:
 *   - ["no_default", reason]  nothing set, nothing to do
 *   - ["skip", reason]        already a PaymentMethod, or an unknown object type
 *   - ["no_match", reason]    a legacy Source with no matching PaymentMethod
 *   - ["promote", pmId]       a legacy Source with a matching PaymentMethod to promote
 */
export function decide(defaultId, defaultFingerprint, paymentMethods) {
  if (!defaultId) return ["no_default", "customer has no default payment set"];
  if (defaultId.startsWith("pm_")) return ["skip", "default is already a PaymentMethod"];
  if (!defaultId.startsWith("src_")) {
    return ["skip", "default is neither a Source nor a PaymentMethod"];
  }

  const matches = paymentMethods.filter(
    (pm) => defaultFingerprint != null && pm.card?.fingerprint === defaultFingerprint
  );
  if (matches.length === 0) {
    return ["no_match", "default is a legacy Source with no matching PaymentMethod"];
  }

  // Prefer the most recently created match if more than one exists.
  const best = matches.reduce((a, b) => ((b.created || 0) > (a.created || 0) ? b : a));
  return ["promote", best.id];
}

async function promoteDefault(customerId, paymentMethodId) {
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
}

export async function run() {
  let promoted = 0;
  let unresolved = 0;
  for await (const customerId of activeSubscriptionCustomers()) {
    const { customer, methods } = await loadCustomerState(customerId);
    const defaultId = customer.invoice_settings?.default_payment_method || customer.default_source;
    const fingerprint = await sourceFingerprint(defaultId);
    const [action, payload] = decide(defaultId, fingerprint, methods);

    if (action === "skip" || action === "no_default") continue;
    if (action === "no_match") {
      console.warn(`Customer ${customerId}: ${payload}`);
      unresolved++;
      continue;
    }

    console.log(
      `Customer ${customerId}: promoting ${payload} over ${defaultId}. ${DRY_RUN ? "would promote" : "promoting"}`
    );
    if (!DRY_RUN) await promoteDefault(customerId, payload);
    promoted++;
  }

  console.log(
    `Done. ${promoted} customer(s) ${DRY_RUN ? "to promote" : "promoted"}, ${unresolved} unresolved (no matching PaymentMethod).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
