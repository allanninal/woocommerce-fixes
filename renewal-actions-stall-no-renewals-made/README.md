# Renewal actions stall, no renewals made

WooCommerce Subscriptions renews a subscription by scheduling a `woocommerce_scheduled_subscription_payment` action in Action Scheduler for the subscription's next payment date. When the Action Scheduler queue runner stalls (WP-Cron disabled, a stuck "in-progress" claim, PHP timing out mid batch), that action never fires. The subscription stays active, its next payment date drifts into the past, and no renewal order and no charge are ever created. This job finds every subscription in that state and triggers the renewal directly, charging the saved payment method with Stripe and creating the renewal order over the WooCommerce REST API. Read only by default.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/renewal-actions-stall-no-renewals-made/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export GRACE_HOURS="6"
export DRY_RUN="true"   # start safe, change to false to write

python renewal-actions-stall-no-renewals-made/python/trigger_stalled_renewals.py
node   renewal-actions-stall-no-renewals-made/node/trigger-stalled-renewals.js
```

`decide` is a pure function: a subscription is only triggered when it is active, its next payment date has passed by more than `GRACE_HOURS`, no renewal order already exists for the period, and it has a saved payment method. Subscriptions with no saved payment method are flagged for manual dunning instead of being charged blind. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest renewal-actions-stall-no-renewals-made/python
node --test renewal-actions-stall-no-renewals-made/node
```
