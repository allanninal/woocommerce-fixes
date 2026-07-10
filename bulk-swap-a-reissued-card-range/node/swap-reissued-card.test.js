import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, currentCardToken, customerIdOf } from "./swap-reissued-card.js";

const AFFECTED = new Set(["pm_old_1", "pm_old_2"]);

function sub({ status = "active", token = "pm_old_1", customer = "cus_1" } = {}) {
  const meta = [];
  if (token) meta.push({ key: "_stripe_source_id", value: token });
  if (customer) meta.push({ key: "_stripe_customer_id", value: customer });
  return { id: 42, status, meta_data: meta };
}

const pm = (id = "pm_new_1") => ({ id });

test("swap when on reissued range and clean replacement ready", () => {
  assert.equal(decide(sub(), AFFECTED, pm("pm_new_1"))[0], "swap");
});

test("skip when subscription not active", () => {
  assert.equal(decide(sub({ status: "cancelled" }), AFFECTED, pm("pm_new_1"))[0], "skip");
});

test("skip when no stored token", () => {
  assert.equal(decide(sub({ token: null }), AFFECTED, pm("pm_new_1"))[0], "skip");
});

test("skip when token not in affected range", () => {
  assert.equal(decide(sub({ token: "pm_fine_1" }), AFFECTED, pm("pm_new_1"))[0], "skip");
});

test("needs-attention when no replacement on file", () => {
  assert.equal(decide(sub(), AFFECTED, null)[0], "needs-attention");
});

test("needs-attention when default is also affected", () => {
  assert.equal(decide(sub(), AFFECTED, pm("pm_old_2"))[0], "needs-attention");
});

test("skip when already on the new token", () => {
  assert.equal(decide(sub({ token: "pm_new_1" }), AFFECTED, pm("pm_new_1"))[0], "skip");
});

test("currentCardToken reads _stripe_source_id", () => {
  assert.equal(currentCardToken(sub({ token: "pm_old_1" })), "pm_old_1");
});

test("customerIdOf reads _stripe_customer_id", () => {
  assert.equal(customerIdOf(sub({ customer: "cus_99" })), "cus_99");
});
