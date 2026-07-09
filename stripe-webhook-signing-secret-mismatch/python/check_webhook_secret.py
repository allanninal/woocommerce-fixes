"""Find a Stripe webhook signing secret mismatch that makes WooCommerce reject events.
Read only. It reports the problem and the fix, it does not change anything.

Guide: https://www.allanninal.dev/woocommerce/stripe-webhook-signing-secret-mismatch/
"""
import os
import json
import subprocess
import stripe

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]


def diagnose_secret(secret):
    if not secret:
        return ["no webhook signing secret is saved in the plugin"]
    if secret.startswith("we_"):
        return ["the endpoint ID was saved instead of the signing secret (needs the whsec_ value)"]
    if not secret.startswith("whsec_"):
        return ["the saved value does not look like a signing secret (should start with whsec_)"]
    return []


def read_plugin_settings():
    # Falls back to an environment variable when WP-CLI is not available.
    if os.environ.get("WC_STRIPE_WEBHOOK_SECRET"):
        return os.environ["WC_STRIPE_WEBHOOK_SECRET"], os.environ.get("WC_STRIPE_TESTMODE") == "yes"
    raw = subprocess.check_output(
        ["wp", "option", "get", "woocommerce_stripe_settings", "--format=json"],
        text=True,
    )
    data = json.loads(raw)
    testmode = data.get("testmode") == "yes"
    secret = data.get("test_webhook_secret" if testmode else "webhook_secret", "")
    return secret, testmode


def deliveries_failing(limit=100):
    pending = total = 0
    for event in stripe.Event.list(limit=limit).auto_paging_iter():
        total += 1
        if event.get("pending_webhooks", 0) > 0:
            pending += 1
    return pending, total


def run():
    secret, testmode = read_plugin_settings()
    mode = "test" if testmode else "live"
    print(f"Plugin is in {mode} mode.")
    issues = diagnose_secret(secret)
    if issues:
        for issue in issues:
            print(f"  PROBLEM: {issue}")
    else:
        print("  The saved secret looks like a valid whsec_ value.")
    pending, total = deliveries_failing()
    print(f"Recent events checked: {total}, still pending delivery: {pending}")
    if pending and not issues:
        print("  The secret format is fine but deliveries still fail. The saved secret is likely")
        print("  out of date or from the wrong mode. Copy the signing secret from the Stripe")
        print("  endpoint and paste it into the plugin webhook settings for the matching mode.")
    if issues:
        print("  Fix: open the webhook endpoint in Stripe, reveal its signing secret, and paste the")
        print(f"  whsec_ value into the plugin webhook settings for {mode} mode.")


if __name__ == "__main__":
    run()
