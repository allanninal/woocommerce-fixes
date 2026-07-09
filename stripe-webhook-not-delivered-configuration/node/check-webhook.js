/**
 * Check whether the Stripe webhook that WooCommerce depends on is set up right.
 * Read only. It reports problems, it does not change anything.
 *
 * Guide: https://www.allanninal.dev/woocommerce/stripe-webhook-not-delivered-configuration/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const STORE_HOST = new URL(process.env.WOO_STORE_URL || "https://example.com").host;

const REQUIRED = ["payment_intent.succeeded", "payment_intent.payment_failed",
                  "charge.succeeded", "charge.refunded"];

export function endpointHealth(endpoint, storeHost) {
  const events = new Set(endpoint.enabled_events || []);
  const covers = events.has("*") || REQUIRED.every((e) => events.has(e));
  let hostOk = false;
  try { hostOk = new URL(endpoint.url).host === storeHost; } catch (e) { hostOk = false; }
  return {
    id: endpoint.id,
    url: endpoint.url || "",
    enabled: endpoint.status === "enabled",
    pointsAtStore: hostOk,
    coversEvents: covers,
    missingEvents: covers ? [] : REQUIRED.filter((e) => !events.has(e)),
  };
}

async function checkEndpoints(storeHost) {
  const reports = [];
  for await (const endpoint of stripe.webhookEndpoints.list({ limit: 100 })) {
    reports.push(endpointHealth(endpoint, storeHost));
  }
  return reports;
}

async function undeliveredRecent(limit = 100) {
  let pending = 0, total = 0;
  for await (const event of stripe.events.list({ limit })) {
    total++;
    if ((event.pending_webhooks || 0) > 0) pending++;
  }
  return { checked: total, stillPending: pending };
}

export async function run() {
  const reports = await checkEndpoints(STORE_HOST);
  const healthy = reports.filter((r) => r.enabled && r.pointsAtStore && r.coversEvents);
  console.log(`Found ${reports.length} endpoint(s). ${healthy.length} healthy for this store.`);
  for (const r of reports) {
    const flags = [];
    if (!r.enabled) flags.push("disabled");
    if (!r.pointsAtStore) flags.push("wrong domain");
    if (!r.coversEvents) flags.push("missing events: " + r.missingEvents.join(", "));
    console.log(`  ${r.id}  ${r.url}  ->  ${flags.length ? "PROBLEM: " + flags.join("; ") : "OK"}`);
  }
  if (!healthy.length) console.log("No healthy endpoint points at this store. That is why orders do not update.");
  const delivery = await undeliveredRecent();
  console.log(`Recent events checked: ${delivery.checked}, still pending delivery: ${delivery.stillPending}`);
  if (delivery.stillPending) {
    console.log("Events are not being accepted by your endpoint. Check for a firewall, CDN, or a server error.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
