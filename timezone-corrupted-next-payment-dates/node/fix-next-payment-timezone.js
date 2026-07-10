/**
 * Detect and repair WooCommerce Subscriptions next payment dates that were saved in
 * the site's local time instead of UTC.
 *
 * WooCommerce Subscriptions requires every schedule date (next_payment, trial_end,
 * end) to be stored in UTC. A local timezone plugin, a server timezone change, or a
 * hand edit through wp_postmeta or the orders table can save the site's local wall
 * clock time in that UTC field instead. The stored date then sits hours away from the
 * true UTC due date, which makes Action Scheduler fire the renewal early, fire it
 * twice in the same day if the store observes daylight saving, or miss the window and
 * leave the subscription looking overdue when it is not.
 *
 * This script reads the subscription's saved schedule through the WooCommerce REST
 * API, works out what the next payment date should be from the last paid renewal
 * order and the billing interval, and compares that to the saved value in whole
 * hours. A clean offset that matches the site's UTC offset (or a small multiple of
 * it, which covers stacked timezone bugs) is corrected. Anything that does not line
 * up with a clean hour offset is left alone and reported. Safe by default: DRY_RUN
 * reports every change it would make without writing anything.
 *
 * Guide: https://www.allanninal.dev/woocommerce/timezone-corrupted-next-payment-dates/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const SITE_UTC_OFFSET_HOURS = Number(process.env.SITE_UTC_OFFSET_HOURS || 0);
const MAX_OFFSET_MULTIPLE = Number(process.env.MAX_OFFSET_MULTIPLE || 2);
const TOLERANCE_MINUTES = Number(process.env.TOLERANCE_MINUTES || 5);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const BILLING_PERIOD_DAYS = { day: 1, week: 7, month: 30, year: 365 };

/** Parse a WooCommerce date string (assumed UTC, no offset suffix) to epoch millis. */
export function parseWooDate(value) {
  if (!value) return null;
  return Date.parse(`${value}Z`);
}

/** The next payment date a subscription should have, from its last paid renewal. */
export function expectedNextPayment(lastPaidAtMs, billingInterval, billingPeriod) {
  const days = (BILLING_PERIOD_DAYS[billingPeriod] || 30) * Math.max(billingInterval, 1);
  return lastPaidAtMs + days * 86400000;
}

/** Signed whole hours between the expected UTC date and the actual saved UTC date. */
export function hoursOffset(expectedMs, actualMs) {
  return (actualMs - expectedMs) / 3600000;
}

function toWooDateString(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "");
}

/**
 * Pure decision function. No I/O.
 *
 * subscription: object with at least "id", "status", and "next_payment_date_gmt"
 *   (a WooCommerce date string, or null).
 * expectedNextPaymentMs: epoch millis, the correct next payment date computed from
 *   the last paid renewal and the billing schedule, or null.
 *
 * Returns [action, reason, correctedIsoOrNull]:
 *   "skip"   - subscription is not active, or nothing to compare against.
 *   "ok"     - the saved date already matches within tolerance.
 *   "repair" - the saved date is off by a clean multiple of the site's UTC offset;
 *              correctedIso holds the fixed UTC value to write back.
 *   "flag"   - the saved date is wrong but does not line up with a clean offset.
 */
export function decide(
  subscription,
  expectedNextPaymentMs,
  {
    toleranceMinutes = TOLERANCE_MINUTES,
    siteUtcOffsetHours = SITE_UTC_OFFSET_HOURS,
    maxOffsetMultiple = MAX_OFFSET_MULTIPLE,
  } = {}
) {
  if (!["active", "on-hold"].includes(subscription.status)) {
    return ["skip", "subscription is not active", null];
  }

  const saved = parseWooDate(subscription.next_payment_date_gmt);
  if (saved === null || Number.isNaN(saved)) {
    return ["skip", "no next payment date saved", null];
  }

  if (expectedNextPaymentMs === null || expectedNextPaymentMs === undefined) {
    return ["skip", "no expected date to compare against", null];
  }

  const toleranceHours = toleranceMinutes / 60;
  const offset = hoursOffset(expectedNextPaymentMs, saved);

  if (Math.abs(offset) <= toleranceHours) {
    return ["ok", "matches the expected date", null];
  }

  if (siteUtcOffsetHours) {
    for (let multiple = 1; multiple <= maxOffsetMultiple; multiple++) {
      const step = siteUtcOffsetHours * multiple;
      if (Math.abs(Math.abs(offset) - Math.abs(step)) <= toleranceHours) {
        const corrected = toWooDateString(expectedNextPaymentMs);
        return [
          "repair",
          `off by ${multiple}x the site UTC offset (${offset >= 0 ? "+" : ""}${offset.toFixed(1)}h), repairing to ${corrected}`,
          corrected,
        ];
      }
    }
  }

  return ["flag", `off by ${offset >= 0 ? "+" : ""}${offset.toFixed(1)}h, does not match a clean site offset multiple`, null];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getLastPaidRenewal(subId) {
  const batch = await woo(
    `/orders?subscription=${subId}&status=processing,completed&per_page=1&orderby=date&order=desc`
  );
  return batch && batch.length ? batch[0] : null;
}

async function* activeSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active,on-hold&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

async function repairNextPaymentDate(subId, correctedIso) {
  await woo(`/subscriptions/${subId}`, {
    method: "PUT",
    body: JSON.stringify({ next_payment_date_gmt: correctedIso }),
  });
  await woo(`/subscriptions/${subId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Timezone repair: next payment date corrected to ${correctedIso} UTC. ` +
            `The saved date was off by a clean multiple of the site's UTC offset.`,
    }),
  });
}

export async function run() {
  let repaired = 0;
  let flagged = 0;
  for await (const sub of activeSubscriptions()) {
    const renewal = await getLastPaidRenewal(sub.id);
    if (!renewal) {
      console.log(`Subscription ${sub.id}: no paid renewal yet, skipping`);
      continue;
    }

    const lastPaidAtMs = parseWooDate(renewal.date_paid_gmt || renewal.date_created_gmt);
    const billingInterval = Number(sub.billing_interval || 1) || 1;
    const billingPeriod = sub.billing_period || "month";
    const expectedMs = lastPaidAtMs
      ? expectedNextPayment(lastPaidAtMs, billingInterval, billingPeriod)
      : null;

    const [action, reason, correctedIso] = decide(sub, expectedMs);

    if (action === "skip" || action === "ok") continue;

    if (action === "flag") {
      console.warn(`Subscription ${sub.id}: ${reason}`);
      flagged++;
      continue;
    }

    console.log(`Subscription ${sub.id}: ${reason}. ${DRY_RUN ? "would repair" : "repairing"}`);
    if (!DRY_RUN) await repairNextPaymentDate(sub.id, correctedIso);
    repaired++;
  }
  console.log(`Done. ${repaired} subscription(s) ${DRY_RUN ? "to repair" : "repaired"}, ${flagged} flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
