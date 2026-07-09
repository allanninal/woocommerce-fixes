# Stripe webhook not delivered to WooCommerce

When no order ever updates, the webhook is usually the cause: the endpoint is wrong, disabled, or missing events. This read only diagnostic lists your webhook endpoints, checks that one is enabled, points at your store, and covers the events WooCommerce needs, then counts recent events that failed to deliver.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/stripe-webhook-not-delivered-configuration/

## Run it

```bash
python stripe-webhook-not-delivered-configuration/python/check_webhook.py
node   stripe-webhook-not-delivered-configuration/node/check-webhook.js
```

This one never writes. It only reads and reports.

## Test

```bash
pytest stripe-webhook-not-delivered-configuration/python
node --test stripe-webhook-not-delivered-configuration/node
```
