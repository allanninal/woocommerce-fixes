import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseSecret } from "./check-webhook-secret.js";

test("valid secret has no issues", () => {
  assert.deepEqual(diagnoseSecret("whsec_abc123"), []);
});

test("empty secret is flagged", () => {
  assert.ok(diagnoseSecret("").length > 0);
});

test("endpoint id is flagged", () => {
  assert.ok(diagnoseSecret("we_123")[0].includes("endpoint ID"));
});

test("random value is flagged", () => {
  assert.ok(diagnoseSecret("hello")[0].startsWith("the saved value"));
});
