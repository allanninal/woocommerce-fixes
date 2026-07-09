import { test } from "node:test";
import assert from "node:assert/strict";
import { duplicateSets, chooseExtras } from "./refund-duplicates.js";

const charge = (id, orderId, over = {}) => ({
  id, amount: 5000, currency: "usd", created: 1, refunded: false,
  status: "succeeded", metadata: { order_id: orderId }, ...over,
});

test("detects two charges for the same order and amount", () => {
  const dups = duplicateSets([charge("ch_1", "42"), charge("ch_2", "42")]);
  assert.equal(dups.size, 1);
});

test("ignores a single charge", () => {
  assert.equal(duplicateSets([charge("ch_1", "42")]).size, 0);
});

test("ignores different amounts", () => {
  const dups = duplicateSets([charge("ch_1", "42"), charge("ch_2", "42", { amount: 1000 })]);
  assert.equal(dups.size, 0);
});

test("keeps the recorded charge", () => {
  const same = [charge("ch_1", "42", { created: 1 }), charge("ch_2", "42", { created: 2 })];
  assert.deepEqual(chooseExtras(same, "ch_2").map((c) => c.id), ["ch_1"]);
});

test("keeps the earliest when none recorded", () => {
  const same = [charge("ch_1", "42", { created: 1 }), charge("ch_2", "42", { created: 2 })];
  assert.deepEqual(chooseExtras(same, null).map((c) => c.id), ["ch_2"]);
});
