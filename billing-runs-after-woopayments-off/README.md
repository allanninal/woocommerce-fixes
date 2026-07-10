# Billing runs after WooPayments off

Disabling WooPayments only removes it from the checkout gateway list. It does not touch subscriptions that were already created with it as their payment method, and WooCommerce Subscriptions will keep firing the scheduled renewal for those subscriptions regardless, so every automatic charge attempt fails against a gateway that is no longer active. This script lists active and on-hold subscriptions through the WooCommerce REST API, finds the ones still saved on a gateway you name as disabled, and sets `requires_manual_renewal` to true so the automatic attempt stops, without touching price, next payment date, or line items.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/billing-runs-after-woopayments-off/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export STRIPE_SECRET_KEY="sk_live_..."
export DISABLED_GATEWAYS="woocommerce_payments"
export DRY_RUN="true"

python billing-runs-after-woopayments-off/python/stop_billing_on_disabled_gateway.py
node   billing-runs-after-woopayments-off/node/stop-billing-on-disabled-gateway.js
```

`decide` is a pure function: a subscription is only repaired when it is active or on-hold, not already set to manual renewal, and its saved payment method matches one of the gateway ids in `DISABLED_GATEWAYS`. Start with `DRY_RUN=true` to review the list before it writes anything.

## Test

```bash
pytest billing-runs-after-woopayments-off/python
node --test billing-runs-after-woopayments-off/node
```
