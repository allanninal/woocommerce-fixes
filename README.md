# WooCommerce Fixes

Small, tested Python and Node.js scripts that detect and repair real problems across **WooCommerce**, **WooCommerce Subscriptions**, and the **WooCommerce Stripe** gateway. Stuck orders, lost webhooks, double charges, broken renewals, token and migration issues, and more.

Every fix is safe by default. The scripts start in a dry run mode that reports what they would do, so you can read the plan before anything writes.

By **[Allan Niñal](https://github.com/allanninal)** — AI Solutions Engineer. I build AI powered tools, data products, and AWS automation.
Full write ups with diagrams for each fix live at **[allanninal.dev/woocommerce](https://www.allanninal.dev/woocommerce/)**.

[![Follow on GitHub](https://img.shields.io/github/followers/allanninal?label=Follow%20%40allanninal&style=social)](https://github.com/allanninal)
[![Tests](https://github.com/allanninal/woocommerce-fixes/actions/workflows/tests.yml/badge.svg)](https://github.com/allanninal/woocommerce-fixes/actions/workflows/tests.yml)

## How the scripts work

Most fixes talk to two systems:

- **Stripe**, through the official SDK (`stripe` for Python, `stripe` for Node).
- **WooCommerce**, through the REST API, so everything works the same on stores that use High Performance Order Storage.

The link between the two is usually the same. Stripe objects carry `metadata.order_id`, and WooCommerce orders carry `_stripe_intent_id`, `_stripe_charge_id`, and `_transaction_id`. Some fixes touch WooCommerce or WooCommerce Subscriptions on their own, with no Stripe call at all.

## Setup

Set the environment variables a fix needs. Create the WooCommerce key pair under WooCommerce, Settings, Advanced, REST API.

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"   # start safe
```

Python needs `pip install stripe requests`. Node needs `npm install stripe` and Node 18 or newer.

## The fixes

| Fix | What it does | Type | Guide |
|---|---|---|---|
| [paid-orders-stuck-on-pending](./paid-orders-stuck-on-pending/) | Finish paid orders the webhook missed | Reconciler | [Read](https://www.allanninal.dev/woocommerce/paid-orders-stuck-on-pending/) |
| [missing-intent-id-webhook-cannot-match-order](./missing-intent-id-webhook-cannot-match-order/) | Recover the lost PaymentIntent ID and backfill it | Repair | [Read](https://www.allanninal.dev/woocommerce/missing-intent-id-webhook-cannot-match-order/) |
| [stripe-webhook-not-delivered-configuration](./stripe-webhook-not-delivered-configuration/) | Check the webhook endpoint and its deliveries | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/stripe-webhook-not-delivered-configuration/) |
| [duplicate-charge-redirect-webhook-race](./duplicate-charge-redirect-webhook-race/) | Find double charges and refund the extra | Reconciler | [Read](https://www.allanninal.dev/woocommerce/duplicate-charge-redirect-webhook-race/) |
| [stripe-webhook-signing-secret-mismatch](./stripe-webhook-signing-secret-mismatch/) | Find the signing secret mismatch that rejects every webhook | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/stripe-webhook-signing-secret-mismatch/) |
| [stripe-dashboard-refund-not-synced](./stripe-dashboard-refund-not-synced/) | Record Stripe dashboard refunds missing from WooCommerce | Reconciler | [Read](https://www.allanninal.dev/woocommerce/stripe-dashboard-refund-not-synced/) |
| [orders-stuck-requires-action-3ds](./orders-stuck-requires-action-3ds/) | Resolve orders stuck on 3D Secure, free held stock | Reconciler | [Read](https://www.allanninal.dev/woocommerce/orders-stuck-requires-action-3ds/) |
| [subscription-on-hold-after-successful-renewal](./subscription-on-hold-after-successful-renewal/) | Reactivate subscriptions paid but stuck On-Hold (HPOS) | Reconciler | [Read](https://www.allanninal.dev/woocommerce/subscription-on-hold-after-successful-renewal/) |
| [declined-card-order-stuck-pending](./declined-card-order-stuck-pending/) | Fail declined-card orders left on Pending, free stock | Repair | [Read](https://www.allanninal.dev/woocommerce/declined-card-order-stuck-pending/) |
| [subscription-missing-saved-card-token](./subscription-missing-saved-card-token/) | Recover the lost Stripe card so renewals work again | Reconciler | [Read](https://www.allanninal.dev/woocommerce/subscription-missing-saved-card-token/) |
| [cancel-abandoned-payment-intents](./cancel-abandoned-payment-intents/) | Cancel abandoned PaymentIntents and their pending orders | Reconciler | [Read](https://www.allanninal.dev/woocommerce/cancel-abandoned-payment-intents/) |
| [refund-webhook-skips-non-card-methods](./refund-webhook-skips-non-card-methods/) | Record refunds on iDEAL/EPS/SEPA the webhook skipped | Repair | [Read](https://www.allanninal.dev/woocommerce/refund-webhook-skips-non-card-methods/) |
| [stripe-fee-net-stale-after-refund](./stripe-fee-net-stale-after-refund/) | Recompute stale Stripe fee and net after a refund | Repair | [Read](https://www.allanninal.dev/woocommerce/stripe-fee-net-stale-after-refund/) |
| [replay-missed-stripe-webhook-events](./replay-missed-stripe-webhook-events/) | Replay Stripe events missed during downtime | Reconciler | [Read](https://www.allanninal.dev/woocommerce/replay-missed-stripe-webhook-events/) |

More fixes land as the guides are published. Watch or star the repo to follow along.

## Running the tests

The decision logic in every fix is a pure function with no network calls, so the tests run anywhere.

```bash
# Python
pip install pytest
pytest

# Node
node --test
```

## A note on safety

These scripts can change orders, subscriptions, and issue refunds. Always run with `DRY_RUN=true` first, read the output, and confirm it is correct before you let a script write. Test against a staging store when you can.

## Work with me

Fighting a WooCommerce, WooCommerce Subscriptions, or WooCommerce Stripe bug you would rather hand off? That is what I do.

- GitHub: [github.com/allanninal](https://github.com/allanninal)
- LinkedIn: [in/allanninal](https://www.linkedin.com/in/allanninal/)
- Support the work: [ko-fi.com/allanninal](https://ko-fi.com/allanninal)

## License

MIT. Use it, change it, ship it.
