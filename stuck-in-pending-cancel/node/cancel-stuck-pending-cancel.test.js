import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, stripeSubIdOf, parseGmt } from "./cancel-stuck-pending-cancel.js";

const NOW = new Date("2026-07-10T12:00:00Z");

const sub = (over = {}) => ({
  status: "pending-cancel",
  end_date_gmt: "2026-07-01 00:00:00",
  meta_data: [],
  ...over,
});

const stripeSub = (over = {}) => ({ status: "canceled", ...over });

test("skip when not pending-cancel", () => {
  assert.equal(decide(sub({ status: "active" }), null, NOW)[0], "skip");
});

test("wait when end date in future", () => {
  assert.equal(decide(sub({ end_date_gmt: "2026-08-01 00:00:00" }), null, NOW)[0], "wait");
});

test("hold when no end date set", () => {
  assert.equal(decide(sub({ end_date_gmt: "0000-00-00 00:00:00" }), null, NOW)[0], "hold");
});

test("hold when end date is empty string", () => {
  assert.equal(decide(sub({ end_date_gmt: "" }), null, NOW)[0], "hold");
});

test("cancel when end passed and no stripe id", () => {
  assert.equal(decide(sub(), null, NOW)[0], "cancel");
});

test("cancel when end passed and stripe agrees canceled", () => {
  const s = sub({ meta_data: [{ key: "_stripe_subscription_id", value: "sub_123" }] });
  assert.equal(decide(s, stripeSub({ status: "canceled" }), NOW)[0], "cancel");
});

test("hold when stripe still active", () => {
  const s = sub({ meta_data: [{ key: "_stripe_subscription_id", value: "sub_123" }] });
  assert.equal(decide(s, stripeSub({ status: "active" }), NOW)[0], "hold");
});

test("hold when stripe past_due", () => {
  const s = sub({ meta_data: [{ key: "_stripe_subscription_id", value: "sub_123" }] });
  assert.equal(decide(s, stripeSub({ status: "past_due" }), NOW)[0], "hold");
});

test("cancel when end is exactly now", () => {
  assert.equal(decide(sub({ end_date_gmt: "2026-07-10 12:00:00" }), null, NOW)[0], "cancel");
});

test("stripeSubIdOf from meta", () => {
  const s = sub({ meta_data: [{ key: "_stripe_subscription_id", value: "sub_abc" }] });
  assert.equal(stripeSubIdOf(s), "sub_abc");
});

test("stripeSubIdOf null when missing", () => {
  assert.equal(stripeSubIdOf(sub()), null);
});

test("parseGmt null for zero date", () => {
  assert.equal(parseGmt("0000-00-00 00:00:00"), null);
});

test("parseGmt parses a real date", () => {
  const dt = parseGmt("2026-07-01 00:00:00");
  assert.equal(dt.getUTCFullYear(), 2026);
  assert.equal(dt.getUTCMonth(), 6);
  assert.equal(dt.getUTCDate(), 1);
});
