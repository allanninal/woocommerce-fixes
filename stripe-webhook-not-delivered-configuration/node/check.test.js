import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointHealth } from "./check-webhook.js";

const STORE = "shop.example.com";
const ALL = ["payment_intent.succeeded", "payment_intent.payment_failed",
             "charge.succeeded", "charge.refunded"];

const ep = (over = {}) => ({
  id: "we_1", status: "enabled",
  url: "https://shop.example.com/?wc-ajax=wc_stripe",
  enabled_events: ALL, ...over,
});

test("healthy endpoint passes", () => {
  const r = endpointHealth(ep(), STORE);
  assert.ok(r.enabled && r.pointsAtStore && r.coversEvents);
});

test("disabled is flagged", () => {
  assert.equal(endpointHealth(ep({ status: "disabled" }), STORE).enabled, false);
});

test("wrong domain is flagged", () => {
  assert.equal(endpointHealth(ep({ url: "https://old.com/?wc-ajax=wc_stripe" }), STORE).pointsAtStore, false);
});

test("missing events are listed", () => {
  const r = endpointHealth(ep({ enabled_events: ["charge.succeeded"] }), STORE);
  assert.ok(r.missingEvents.includes("payment_intent.succeeded"));
});

test("star covers everything", () => {
  assert.equal(endpointHealth(ep({ enabled_events: ["*"] }), STORE).coversEvents, true);
});
