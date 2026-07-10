import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./fix-coupon-expiry-timezone.js";

const coupon = (over = {}) => ({
  id: 1, code: "SUMMER10", date_expires_gmt: "2026-07-10T00:00:00", ...over,
});

test("skip when no expiry", () => {
  assert.equal(decide(coupon({ date_expires_gmt: "" }), 480)[0], "skip");
});

test("skip when expiry is null", () => {
  assert.equal(decide(coupon({ date_expires_gmt: null }), 480)[0], "skip");
});

test("correct when positive offset expires mid day", () => {
  // Manila, UTC+8. Midnight UTC on 2026-07-10 is 08:00 local the same day,
  // hours before end of day. Should be corrected forward.
  const [action, , corrected] = decide(coupon(), 480);
  assert.equal(action, "correct");
  assert.equal(corrected, "2026-07-10T15:59:59");
});

test("correct when negative offset crosses to wrong day", () => {
  // New York, UTC-5. Midnight UTC on 2026-07-10 is 19:00 local on
  // 2026-07-09, an entirely different calendar day than intended.
  const [action, reason, corrected] = decide(coupon(), -300);
  assert.equal(action, "correct");
  assert.match(reason, /wrong local calendar day/);
  assert.equal(corrected, "2026-07-10T04:59:59");
});

test("ok when already end of local day", () => {
  assert.equal(decide(coupon({ date_expires_gmt: "2026-07-10T15:59:59" }), 480)[0], "ok");
});

test("correct even for utc offset zero", () => {
  const [action, , corrected] = decide(coupon(), 0);
  assert.equal(action, "correct");
  assert.equal(corrected, "2026-07-10T23:59:59");
});

test("ok for utc store already at end of day", () => {
  assert.equal(decide(coupon({ date_expires_gmt: "2026-07-10T23:59:59" }), 0)[0], "ok");
});
