import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, tokenGateway, tokenPmId } from "./migrate-woopayments-tokens.js";

const token = (over = {}) => ({ id: 9, gateway_id: "woocommerce_payments", token: "pm_1MigratedCard", ...over });

test("repoint when pm confirmed on new account", () => {
  const pm = { status: "attached", id: "pm_1MigratedCard" };
  assert.equal(decide(token(), pm)[0], "repoint");
});

test("missing when pm not found on new account", () => {
  assert.equal(decide(token(), null)[0], "missing");
});

test("missing when pm is detached on new account", () => {
  const pm = { status: "detached", id: "pm_1MigratedCard" };
  assert.equal(decide(token(), pm)[0], "missing");
});

test("skip when token not on woopayments gateway", () => {
  const t = token({ gateway_id: "stripe" });
  const pm = { status: "attached", id: "pm_1MigratedCard" };
  assert.equal(decide(t, pm)[0], "skip");
});

test("skip when token has no pm id", () => {
  const t = token({ token: "" });
  assert.equal(decide(t, null)[0], "skip");
});

test("woopayments alias gateway is also matched", () => {
  const t = token({ gateway_id: "woopayments" });
  const pm = { status: "attached", id: "pm_1MigratedCard" };
  assert.equal(decide(t, pm)[0], "repoint");
});

test("tokenGateway reads gateway_id", () => {
  assert.equal(tokenGateway({ gateway_id: "woocommerce_payments" }), "woocommerce_payments");
});

test("tokenGateway falls back to gateway key", () => {
  assert.equal(tokenGateway({ gateway: "woocommerce_payments" }), "woocommerce_payments");
});

test("tokenPmId reads token field", () => {
  assert.equal(tokenPmId({ token: "pm_abc" }), "pm_abc");
});
