import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, expectedNextPayment, hoursOffset, parseWooDate } from "./fix-next-payment-timezone.js";

const ms = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);

const subscription = (over = {}) => ({
  id: 501,
  status: "active",
  next_payment_date_gmt: "2026-08-10T00:00:00",
  ...over,
});

test("ok when saved matches expected", () => {
  const expected = ms(2026, 8, 10, 0, 0);
  const sub = subscription({ next_payment_date_gmt: "2026-08-10T00:00:00" });
  const [action, , corrected] = decide(sub, expected);
  assert.equal(action, "ok");
  assert.equal(corrected, null);
});

test("repair when off by one site offset", () => {
  // Site is UTC+8. The saved date was written 8 hours ahead of the true UTC value.
  const expected = ms(2026, 8, 10, 0, 0);
  const sub = subscription({ next_payment_date_gmt: "2026-08-10T08:00:00" });
  const [action, , corrected] = decide(sub, expected, { siteUtcOffsetHours: 8 });
  assert.equal(action, "repair");
  assert.equal(corrected, "2026-08-10T00:00:00");
});

test("repair when off by two times the offset", () => {
  const expected = ms(2026, 8, 10, 0, 0);
  const sub = subscription({ next_payment_date_gmt: "2026-08-10T16:00:00" });
  const [action, , corrected] = decide(sub, expected, { siteUtcOffsetHours: 8, maxOffsetMultiple: 2 });
  assert.equal(action, "repair");
  assert.equal(corrected, "2026-08-10T00:00:00");
});

test("repair handles negative site offset", () => {
  // Site is UTC-5. Saved date drifted 5 hours behind the true UTC value.
  const expected = ms(2026, 8, 10, 12, 0);
  const sub = subscription({ next_payment_date_gmt: "2026-08-10T07:00:00" });
  const [action, , corrected] = decide(sub, expected, { siteUtcOffsetHours: -5 });
  assert.equal(action, "repair");
  assert.equal(corrected, "2026-08-10T12:00:00");
});

test("flag when offset does not match a clean multiple", () => {
  const expected = ms(2026, 8, 10, 0, 0);
  const sub = subscription({ next_payment_date_gmt: "2026-08-10T03:00:00" });
  const [action, , corrected] = decide(sub, expected, { siteUtcOffsetHours: 8 });
  assert.equal(action, "flag");
  assert.equal(corrected, null);
});

test("skip when subscription not active", () => {
  const expected = ms(2026, 8, 10, 0, 0);
  const sub = subscription({ status: "cancelled" });
  const [action] = decide(sub, expected);
  assert.equal(action, "skip");
});

test("skip when no saved date", () => {
  const expected = ms(2026, 8, 10, 0, 0);
  const sub = subscription({ next_payment_date_gmt: null });
  const [action] = decide(sub, expected);
  assert.equal(action, "skip");
});

test("skip when no expected date to compare", () => {
  const sub = subscription();
  const [action] = decide(sub, null);
  assert.equal(action, "skip");
});

test("within tolerance counts as ok", () => {
  const expected = ms(2026, 8, 10, 0, 0);
  const sub = subscription({ next_payment_date_gmt: "2026-08-10T00:03:00" });
  const [action] = decide(sub, expected, { toleranceMinutes: 5 });
  assert.equal(action, "ok");
});

test("expectedNextPayment adds billing interval days", () => {
  const lastPaid = ms(2026, 7, 10, 0, 0);
  assert.equal(expectedNextPayment(lastPaid, 1, "month"), ms(2026, 8, 9, 0, 0));
});

test("expectedNextPayment handles multi interval", () => {
  const lastPaid = ms(2026, 1, 1, 0, 0);
  assert.equal(expectedNextPayment(lastPaid, 3, "month"), ms(2026, 4, 1, 0, 0));
});

test("hoursOffset is signed", () => {
  const expected = ms(2026, 8, 10, 0, 0);
  const actual = ms(2026, 8, 10, 8, 0);
  assert.equal(hoursOffset(expected, actual), 8);
  assert.equal(hoursOffset(actual, expected), -8);
});

test("parseWooDate returns null for empty", () => {
  assert.equal(parseWooDate(null), null);
  assert.equal(parseWooDate(""), null);
});

test("parseWooDate parses as UTC", () => {
  assert.equal(parseWooDate("2026-08-10T00:00:00"), ms(2026, 8, 10, 0, 0));
});
