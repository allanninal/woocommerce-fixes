/**
 * Detect and repair WooCommerce coupons that expire on the wrong local day
 * because date_expires is stored and compared in UTC, not site time.
 *
 * WooCommerce saves a coupon's expiry as a UTC timestamp (date_expires_gmt)
 * and compares it against the current UTC time to decide whether the
 * coupon is still valid. The shop owner picks a date in the WordPress admin
 * thinking in site time (the store's local timezone). For any store west of
 * UTC, midnight UTC on the chosen date lands several hours BEFORE local
 * midnight, so the coupon dies on what the calendar still shows as the
 * intended day. For stores east of UTC, the coupon can also expire hours
 * before end of day, or roll onto the wrong local calendar date entirely.
 *
 * This script asks the WooCommerce REST API for coupons with an expiry
 * date, works out the coupon's actual last valid moment in the store's
 * local timezone, and flags any coupon whose local expiry moment does not
 * land at the end of the calendar day the code implies (23:59:59 local).
 * When it finds one, it can rewrite date_expires_gmt so the coupon
 * actually expires at the end of the intended local day. Dry run by
 * default. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/coupon-expiry-uses-utc-not-site-time/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");

// Store's UTC offset in minutes, e.g. -300 for America/New_York (EST), 480
// for Asia/Manila. WordPress exposes this as gmt_offset (hours) under
// Settings, General. Multiply by 60 if you copy that value in.
const SITE_UTC_OFFSET_MINUTES = Number(process.env.SITE_UTC_OFFSET_MINUTES || 0);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const MINUTE_MS = 60 * 1000;

/**
 * Parse a WooCommerce ISO-ish datetime string ("2026-07-10T00:00:00") as a
 * UTC instant, returned as epoch milliseconds. Returns null for empty or
 * missing values.
 */
export function parseWooDatetime(value) {
  if (!value) return null;
  const iso = value.endsWith("Z") ? value : `${value}Z`;
  return Date.parse(iso);
}

/**
 * Shift a UTC epoch-ms instant by a fixed minute offset and return the
 * "local" epoch-ms value (still a plain instant, just shifted, the same
 * trick WooCommerce's own naive datetimes use).
 */
export function toLocalMs(utcMs, offsetMinutes) {
  return utcMs + offsetMinutes * MINUTE_MS;
}

/**
 * Given a shifted "local" epoch-ms instant, return the UTC epoch-ms instant
 * that corresponds to 23:59:59.000 local time on that same local calendar
 * date.
 */
export function endOfLocalDayInUtcMs(localMs, offsetMinutes) {
  const local = new Date(localMs);
  const endOfDayLocal = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
    23, 59, 59, 0
  );
  return endOfDayLocal - offsetMinutes * MINUTE_MS;
}

function isoNoMillis(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "");
}

/**
 * Pure decision: does this coupon's UTC expiry land on the wrong local day
 * (or the right day but not at the end of it), and if so what should the
 * corrected date_expires_gmt be.
 *
 * coupon: an object with "id", "code", and "date_expires_gmt" (a
 *   WooCommerce-style ISO datetime string, or "" / null when the coupon
 *   never expires).
 * siteUtcOffsetMinutes: the store's fixed UTC offset in minutes.
 *
 * The admin picks a calendar date, e.g. 2026-07-10, and WooCommerce stores
 * that same date at 00:00:00 as date_expires_gmt, treating it as UTC. The
 * "intended" local calendar date is the date portion of that raw string. We
 * check whether the stored UTC instant, once converted to site time, still
 * falls on that same intended date, and whether it lands at the end of
 * that day (23:59:59 local) rather than somewhere in the middle of it.
 *
 * Returns [action, reason, correctedGmtIsoOrNull]:
 *   "skip"    no expiry set, nothing to check
 *   "ok"      the expiry already lands at end of the intended local day
 *   "correct" the expiry is off by more than a minute; correctedGmtIso
 *             holds the ISO string to write back to date_expires_gmt
 */
export function decide(coupon, siteUtcOffsetMinutes) {
  const expiresGmt = coupon.date_expires_gmt;
  if (!expiresGmt) return ["skip", "coupon has no expiry date", null];

  const expiresUtcMs = parseWooDatetime(expiresGmt);
  const intendedDate = expiresGmt.slice(0, 10);

  const localMs = toLocalMs(expiresUtcMs, siteUtcOffsetMinutes);
  const intendedUtcMs = endOfLocalDayInUtcMs(localMs, siteUtcOffsetMinutes);

  const driftSeconds = Math.abs((intendedUtcMs - expiresUtcMs) / 1000);
  if (driftSeconds <= 60) {
    return ["ok", "expiry already lands at end of the local day", null];
  }

  const localDate = new Date(localMs).toISOString().slice(0, 10);
  const reason = localDate !== intendedDate
    ? "expiry crosses UTC midnight onto the wrong local calendar day"
    : "expiry is mid-day in site time, coupon dies hours early";
  return ["correct", reason, isoNoMillis(intendedUtcMs)];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* listExpiringCoupons() {
  let page = 1;
  while (true) {
    const batch = await woo(`/coupons?per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const coupon of batch) {
      if (coupon.date_expires_gmt) yield coupon;
    }
    page++;
  }
}

async function applyFix(couponId, correctedGmtIso) {
  await woo(`/coupons/${couponId}`, {
    method: "PUT",
    body: JSON.stringify({ date_expires_gmt: correctedGmtIso }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const coupon of listExpiringCoupons()) {
    const [action, reason, correctedGmtIso] = decide(coupon, SITE_UTC_OFFSET_MINUTES);
    if (action !== "correct") continue;
    console.log(
      `Coupon ${coupon.id} (${coupon.code}): ${reason}. ${DRY_RUN ? "would correct" : "correcting"}`
    );
    if (!DRY_RUN) await applyFix(coupon.id, correctedGmtIso);
    fixed++;
  }
  console.log(`Done. ${fixed} coupon(s) ${DRY_RUN ? "to correct" : "corrected"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
