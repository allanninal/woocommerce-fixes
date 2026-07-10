import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  keyMode,
  gatewayTestMode,
  modeMismatchFromError,
  intentIdOf,
} from "./detect-key-mixup.js";

const LIVE_MODE_ERROR =
  "No such payment_intent: 'pi_123'; a similar object exists in live mode, " +
  "but a test mode key was used to make this request.";
const TEST_MODE_ERROR =
  "No such payment_intent: 'pi_456'; a similar object exists in test mode, " +
  "but a live mode key was used to make this request.";

test("keyMode detects test secret key", () => {
  assert.equal(keyMode("sk_test_abc123"), "test");
});

test("keyMode detects live secret key", () => {
  assert.equal(keyMode("sk_live_abc123"), "live");
});

test("keyMode detects restricted keys", () => {
  assert.equal(keyMode("rk_test_abc123"), "test");
  assert.equal(keyMode("rk_live_abc123"), "live");
});

test("keyMode unknown for garbage", () => {
  assert.equal(keyMode("not-a-real-key"), "unknown");
  assert.equal(keyMode(null), "unknown");
});

test("gatewayTestMode true when yes", () => {
  assert.equal(gatewayTestMode({ testmode: { value: "yes" } }), true);
});

test("gatewayTestMode false when no", () => {
  assert.equal(gatewayTestMode({ testmode: { value: "no" } }), false);
});

test("gatewayTestMode false when missing", () => {
  assert.equal(gatewayTestMode({}), false);
  assert.equal(gatewayTestMode(null), false);
});

test("modeMismatchFromError live", () => {
  assert.equal(modeMismatchFromError(LIVE_MODE_ERROR), "live");
});

test("modeMismatchFromError test", () => {
  assert.equal(modeMismatchFromError(TEST_MODE_ERROR), "test");
});

test("modeMismatchFromError none for unrelated message", () => {
  assert.equal(modeMismatchFromError("No such payment_intent: 'pi_999'"), null);
});

test("modeMismatchFromError none for empty", () => {
  assert.equal(modeMismatchFromError(null), null);
  assert.equal(modeMismatchFromError(""), null);
});

test("decide match when key and store agree", () => {
  assert.equal(decide("live", false)[0], "match");
});

test("decide match in test mode too", () => {
  assert.equal(decide("test", true)[0], "match");
});

test("decide config_drift when live key but store says test", () => {
  const [verdict, reason] = decide("live", true);
  assert.equal(verdict, "config_drift");
  assert.match(reason, /test mode/);
});

test("decide config_drift when test key but store says live", () => {
  const [verdict, reason] = decide("test", false);
  assert.equal(verdict, "config_drift");
  assert.match(reason, /live mode/);
});

test("decide inconclusive when key mode unknown", () => {
  assert.equal(decide("unknown", false)[0], "inconclusive");
});

test("decide confirmed_mismatch overrides matching config", () => {
  const [verdict, reason] = decide("live", false, LIVE_MODE_ERROR);
  assert.equal(verdict, "confirmed_mismatch");
  assert.match(reason, /live mode/);
});

test("decide confirmed_mismatch test key against live object", () => {
  const [verdict, reason] = decide("test", true, TEST_MODE_ERROR);
  assert.equal(verdict, "confirmed_mismatch");
  assert.match(reason, /test mode/);
});

test("intentIdOf from meta", () => {
  assert.equal(
    intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }),
    "pi_123"
  );
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});
