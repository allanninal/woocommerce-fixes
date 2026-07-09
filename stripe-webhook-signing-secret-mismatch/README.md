# Stripe webhook signing secret mismatch

Stripe rejects every webhook with `No signatures found matching the expected signature`, so no order updates. The signing secret saved in the plugin does not match the one on the Stripe endpoint. This read only diagnostic reads the saved secret with WP-CLI, checks its format, and confirms whether deliveries are failing, then tells you the exact fix.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/stripe-webhook-signing-secret-mismatch/

## Run it

Run where WP-CLI is available, or pass the secret in with `WC_STRIPE_WEBHOOK_SECRET`.

```bash
python stripe-webhook-signing-secret-mismatch/python/check_webhook_secret.py
node   stripe-webhook-signing-secret-mismatch/node/check-webhook-secret.js
```

The signing secret cannot be read back from Stripe, so the fix is a copy and paste from the endpoint into the plugin settings.

## Test

```bash
pytest stripe-webhook-signing-secret-mismatch/python
node --test stripe-webhook-signing-secret-mismatch/node
```
