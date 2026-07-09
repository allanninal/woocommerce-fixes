/**
 * Find a Stripe webhook signing secret mismatch that makes WooCommerce reject events.
 * Read only. It reports the problem and the fix, it does not change anything.
 *
 * Guide: https://www.allanninal.dev/woocommerce/stripe-webhook-signing-secret-mismatch/
 */
import Stripe from "stripe";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");

export function diagnoseSecret(secret) {
  if (!secret) return ["no webhook signing secret is saved in the plugin"];
  if (secret.startsWith("we_")) return ["the endpoint ID was saved instead of the signing secret (needs the whsec_ value)"];
  if (!secret.startsWith("whsec_")) return ["the saved value does not look like a signing secret (should start with whsec_)"];
  return [];
}

export function readPluginSettings() {
  if (process.env.WC_STRIPE_WEBHOOK_SECRET) {
    return { secret: process.env.WC_STRIPE_WEBHOOK_SECRET, testmode: process.env.WC_STRIPE_TESTMODE === "yes" };
  }
  const raw = execFileSync("wp", ["option", "get", "woocommerce_stripe_settings", "--format=json"], { encoding: "utf8" });
  const data = JSON.parse(raw);
  const testmode = data.testmode === "yes";
  const secret = data[testmode ? "test_webhook_secret" : "webhook_secret"] || "";
  return { secret, testmode };
}

async function deliveriesFailing(limit = 100) {
  let pending = 0, total = 0;
  for await (const event of stripe.events.list({ limit })) {
    total++;
    if ((event.pending_webhooks || 0) > 0) pending++;
  }
  return { pending, total };
}

export async function run() {
  const { secret, testmode } = readPluginSettings();
  const mode = testmode ? "test" : "live";
  console.log(`Plugin is in ${mode} mode.`);
  const issues = diagnoseSecret(secret);
  if (issues.length) issues.forEach((i) => console.log(`  PROBLEM: ${i}`));
  else console.log("  The saved secret looks like a valid whsec_ value.");
  const { pending, total } = await deliveriesFailing();
  console.log(`Recent events checked: ${total}, still pending delivery: ${pending}`);
  if (pending && !issues.length) {
    console.log("  The secret format is fine but deliveries still fail. The saved secret is likely");
    console.log("  out of date or from the wrong mode. Copy the signing secret from the Stripe");
    console.log("  endpoint and paste it into the plugin webhook settings for the matching mode.");
  }
  if (issues.length) {
    console.log("  Fix: open the webhook endpoint in Stripe, reveal its signing secret, and paste the");
    console.log(`  whsec_ value into the plugin webhook settings for ${mode} mode.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
