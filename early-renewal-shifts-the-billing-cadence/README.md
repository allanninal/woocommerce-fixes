# Early renewal shifts the billing cadence

When a customer or store manager pays a subscription renewal early ("Renew now" / pay it forward), WooCommerce Subscriptions is supposed to push `next_payment` out to one full billing period from that new paid date. A common bug in custom "renew now" buttons and some REST driven manual renewals pays the order but never recalculates the schedule, so `next_payment` is left pointing at the old cadence. The next charge then fires just days later instead of a full period out, and every early renewal after that compounds the drift. This job reads recent renewal orders, cross checks the paid amount against the Stripe PaymentIntent, and realigns `_schedule_next_payment` to one full billing period after the confirmed paid date.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/early-renewal-shifts-the-billing-cadence/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="3"
export TOLERANCE_SECONDS="3600"
export DRY_RUN="true"

python early-renewal-shifts-the-billing-cadence/python/realign_next_payment.py
node   early-renewal-shifts-the-billing-cadence/node/realign-next-payment.js
```

`decide` is a pure function: a subscription is only fixed when Stripe confirms the renewal succeeded, the paid amount matches the order total, and the recorded `next_payment` drifts from paid date plus one billing period by more than `TOLERANCE_SECONDS`. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest early-renewal-shifts-the-billing-cadence/python
node --test early-renewal-shifts-the-billing-cadence/node
```
