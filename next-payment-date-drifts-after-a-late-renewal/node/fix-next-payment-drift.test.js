import { test } from "node:test";
import assert from "node:assert/strict";
import { correctNextPayment, decide, intentIdOf } from "./fix-next-payment-drift.js";

const dt = (y, m, d, h = 0) => new Date(Date.UTC(y, m - 1, d, h));

test("correctNextPayment steps one month forward", () => {
  const result = correctNextPayment(dt(2026, 1, 15), "month", 1, dt(2026, 3, 20));
  assert.equal(result.getTime(), dt(2026, 4, 15).getTime());
});

test("correctNextPayment handles month length change", () => {
  const result = correctNextPayment(dt(2026, 1, 31), "month", 1, dt(2026, 1, 31, 1));
  assert.equal(result.getTime(), dt(2026, 2, 28).getTime());
});

test("correctNextPayment handles week period", () => {
  const result = correctNextPayment(dt(2026, 1, 1), "week", 2, dt(2026, 1, 20));
  assert.equal(result.getTime(), dt(2026, 1, 29).getTime());
});

test("correctNextPayment handles year period", () => {
  const result = correctNextPayment(dt(2025, 6, 10), "year", 1, dt(2026, 6, 15));
  assert.equal(result.getTime(), dt(2027, 6, 10).getTime());
});

test("correctNextPayment rejects non positive interval", () => {
  assert.throws(() => correctNextPayment(dt(2026, 1, 1), "month", 0, dt(2026, 2, 1)));
});

test("ok when stored date matches schedule", () => {
  const sub = {
    status: "active", billing_period: "month", billing_interval: 1,
    start_date_gmt: dt(2026, 1, 15), next_payment_date_gmt: dt(2026, 4, 15),
  };
  assert.equal(decide(sub, dt(2026, 3, 20))[0], "ok");
});

test("fix when stored date drifted ahead", () => {
  const sub = {
    status: "active", billing_period: "month", billing_interval: 1,
    start_date_gmt: dt(2026, 1, 15), next_payment_date_gmt: dt(2026, 4, 18),
  };
  const [action, reason] = decide(sub, dt(2026, 3, 20));
  assert.equal(action, "fix");
  assert.match(reason, /ahead/);
});

test("fix when stored date drifted behind", () => {
  const sub = {
    status: "active", billing_period: "month", billing_interval: 1,
    start_date_gmt: dt(2026, 1, 15), next_payment_date_gmt: dt(2026, 4, 10),
  };
  const [action, reason] = decide(sub, dt(2026, 3, 20));
  assert.equal(action, "fix");
  assert.match(reason, /behind/);
});

test("skip when subscription not active", () => {
  const sub = {
    status: "on-hold", billing_period: "month", billing_interval: 1,
    start_date_gmt: dt(2026, 1, 15), next_payment_date_gmt: dt(2026, 4, 15),
  };
  assert.equal(decide(sub, dt(2026, 3, 20))[0], "skip");
});

test("skip when no next payment date stored", () => {
  const sub = {
    status: "active", billing_period: "month", billing_interval: 1,
    start_date_gmt: dt(2026, 1, 15), next_payment_date_gmt: null,
  };
  assert.equal(decide(sub, dt(2026, 3, 20))[0], "skip");
});

test("tolerance allows a small gap", () => {
  const sub = {
    status: "active", billing_period: "week", billing_interval: 2,
    start_date_gmt: dt(2026, 1, 1), next_payment_date_gmt: dt(2026, 3, 26, 2),
  };
  assert.equal(decide(sub, dt(2026, 3, 20), 6)[0], "ok");
});

test("intentIdOf from meta", () => {
  assert.equal(intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});
