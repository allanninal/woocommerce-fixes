import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, customerMeta, parseCsv } from "./import-migrated-cards.js";

const row = (over = {}) => ({ oldCustomerId: "old_1", paymentMethodId: "pm_123", ...over });

test("link when customer found and not yet linked", () => {
  assert.equal(decide({ id: 9, meta_data: [] }, row())[0], "link");
});

test("orphan when customer missing", () => {
  assert.equal(decide(null, row())[0], "orphan");
});

test("skip when payment method id missing", () => {
  assert.equal(decide({ id: 9, meta_data: [] }, row({ paymentMethodId: "" }))[0], "skip");
});

test("skip when payment method id is not a pm_ id", () => {
  assert.equal(decide({ id: 9, meta_data: [] }, row({ paymentMethodId: "src_old_123" }))[0], "skip");
});

test("skip when customer already linked", () => {
  const customer = { id: 9, meta_data: [{ key: "_stripe_payment_method_id", value: "pm_999" }] };
  assert.equal(decide(customer, row())[0], "skip");
});

test("customerMeta reads matching key", () => {
  assert.equal(
    customerMeta({ meta_data: [{ key: "_stripe_customer_id", value: "cus_1" }] }, "_stripe_customer_id"),
    "cus_1"
  );
});

test("customerMeta returns null when missing", () => {
  assert.equal(customerMeta({ meta_data: [] }, "_stripe_customer_id"), null);
});

test("parseCsv reads header and rows", () => {
  const rows = parseCsv("old_customer_id,payment_method_id\nold_1,pm_123\nold_2,pm_456");
  assert.deepEqual(rows, [
    { old_customer_id: "old_1", payment_method_id: "pm_123" },
    { old_customer_id: "old_2", payment_method_id: "pm_456" },
  ]);
});
