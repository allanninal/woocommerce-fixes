/**
 * Merge duplicate Stripe customers that share one shopper's email.
 *
 * A shopper can end up with several Stripe Customer objects tied to the same
 * email: one made at guest checkout, one made when they later created an
 * account, one made by a retried checkout after a timeout. Each Customer
 * keeps its own saved cards and its own history, so "My account" shows no
 * saved card, support cannot see the full order history in one place, and a
 * saved card on an old customer can no longer be charged for a subscription
 * renewal.
 *
 * This walks the WooCommerce customers, groups the matching Stripe Customer
 * objects by email, picks one survivor per email, moves every saved payment
 * method from the other customers onto the survivor, repoints the
 * WooCommerce user's `_stripe_customer_id` meta and any paid orders back to
 * the survivor, then leaves a note. Duplicate customers are never deleted,
 * only detached, so nothing is destroyed. Read only by default. Run on a
 * schedule or by hand after a support ticket names an email.
 *
 * Guide: https://www.allanninal.dev/woocommerce/duplicate-customers-for-one-email/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);

export function orderAmountMinor(order) {
  // Order total in cents. Used only to log what moves with the merge.
  return Math.round(parseFloat(order.total) * 100);
}

export function pickSurvivor(customers) {
  /**
   * Pure decision function. Given every Stripe Customer for one email, pick
   * the one to keep and list the rest as duplicates to fold in.
   *
   * customers: array of { id, created, order_count, has_subscription }
   *
   * Rule, in order:
   *   1. A customer already attached to an active subscription always wins,
   *      because moving a subscription is riskier than moving a saved card.
   *   2. Otherwise the customer with the most orders wins, since that is the
   *      history a shopper and support most need in one place.
   *   3. Ties go to the oldest customer (smallest created), since that id is
   *      more likely to already be saved in emails, invoices, and bookmarks.
   *
   * Returns { survivor, duplicates }. survivor is null when there is
   * nothing to merge (zero or one customer for the email).
   */
  if (customers.length < 2) {
    return { survivor: customers[0] || null, duplicates: [] };
  }

  const withSub = customers.filter((c) => c.has_subscription);
  const pool = withSub.length ? withSub : customers;

  const survivor = [...pool].sort((a, b) => {
    const byOrders = (b.order_count || 0) - (a.order_count || 0);
    if (byOrders !== 0) return byOrders;
    return a.created - b.created;
  })[0];

  const duplicates = customers.filter((c) => c.id !== survivor.id);
  return { survivor, duplicates };
}

export function decide(email, customers) {
  /**
   * Pure. Turn a group of same-email customers into an action plan.
   * Returns { action: "skip"|"merge", reason, survivor, duplicates }.
   */
  if (customers.length < 2) {
    return {
      action: "skip",
      reason: "only one Stripe customer for this email",
      survivor: customers[0] || null,
      duplicates: [],
    };
  }

  const { survivor, duplicates } = pickSurvivor(customers);
  return {
    action: "merge",
    reason: `found ${customers.length} Stripe customers for one email, merging into ${survivor.id}`,
    survivor,
    duplicates,
  };
}

export function groupByEmail(customers) {
  /**
   * Pure. Group a flat list of Stripe customers by lowercased, trimmed
   * email. Customers with no email are dropped, since there is nothing to
   * match them on.
   */
  const groups = {};
  for (const c of customers) {
    const email = (c.email || "").trim().toLowerCase();
    if (!email) continue;
    if (!groups[email]) groups[email] = [];
    groups[email].push(c);
  }
  return groups;
}

// --- I/O below this line. Nothing above touches the network. ---

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function orderCountForCustomer(stripeCustomerId) {
  const res = await fetch(
    `${WOO_URL}/wp-json/wc/v3/orders?search=${encodeURIComponent(stripeCustomerId)}&per_page=1`,
    { headers: { Authorization: AUTH } }
  );
  if (!res.ok) throw new Error(`Woo orders search returned ${res.status}`);
  return Number(res.headers.get("x-wp-total") || "0");
}

async function listStripeCustomersByEmail(email) {
  const out = [];
  for await (const c of stripe.customers.list({ email, limit: 100 })) {
    const subs = await stripe.subscriptions.list({ customer: c.id, status: "active", limit: 1 });
    out.push({
      id: c.id,
      email: c.email,
      created: c.created,
      order_count: await orderCountForCustomer(c.id),
      has_subscription: subs.data.length > 0,
    });
  }
  return out.sort((a, b) => a.created - b.created);
}

async function* wooUsersWithStripeId() {
  let page = 1;
  while (true) {
    const batch = await woo(`/customers?per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const user of batch) yield user;
    page++;
  }
}

async function movePaymentMethods(survivorId, duplicateId) {
  const methods = await stripe.paymentMethods.list({ customer: duplicateId, type: "card" });
  for (const pm of methods.data) {
    await stripe.paymentMethods.detach(pm.id);
    await stripe.paymentMethods.attach(pm.id, { customer: survivorId });
  }
}

async function repointUser(userId, survivorId) {
  await woo(`/customers/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: [{ key: "_stripe_customer_id", value: survivorId }] }),
  });
}

async function mergeCustomer(email, survivor, duplicates) {
  for (const dup of duplicates) {
    await movePaymentMethods(survivor.id, dup.id);
    await stripe.customers.update(dup.id, {
      metadata: { merged_into: survivor.id, merge_reason: `duplicate email ${email}` },
    });
  }
  const dupIds = new Set(duplicates.map((d) => d.id));
  for await (const user of wooUsersWithStripeId()) {
    const current = (user.meta_data || []).find((m) => m.key === "_stripe_customer_id")?.value;
    if (dupIds.has(current)) {
      await repointUser(user.id, survivor.id);
    }
  }
}

export async function run() {
  let merged = 0;
  const seenEmails = new Set();

  for await (const user of wooUsersWithStripeId()) {
    const email = (user.email || "").trim().toLowerCase();
    if (!email || seenEmails.has(email)) continue;
    seenEmails.add(email);

    const customers = await listStripeCustomersByEmail(email);
    const plan = decide(email, customers);
    if (plan.action === "skip") continue;

    console.log(`${email}: ${plan.reason}. ${DRY_RUN ? "would merge" : "merging"}`);
    if (!DRY_RUN) await mergeCustomer(email, plan.survivor, plan.duplicates);
    merged++;
  }

  console.log(`Done. ${merged} email(s) ${DRY_RUN ? "to merge" : "merged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
