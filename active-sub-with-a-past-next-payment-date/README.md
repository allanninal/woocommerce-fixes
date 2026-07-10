# Active sub with a past next payment date

A WooCommerce subscription can stay Active while its schedule quietly falls behind: the scheduled Action Scheduler event that should trigger the renewal fails to run (WP-Cron disabled, a backed up queue, a bad migration), so `next_payment` never advances and eventually sits in the past. This job lists Active subscriptions, skips any that already have a renewal in progress at Stripe, and reschedules the rest forward to the next sensible future date using each subscription's own billing period and interval. Dry run by default. Run on a schedule.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/active-sub-with-a-past-next-payment-date/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export GRACE_HOURS="2"
export DRY_RUN="true"   # true also just reports what it would change

python active-sub-with-a-past-next-payment-date/python/fix_past_next_payment.py
node   active-sub-with-a-past-next-payment-date/node/fix-past-next-payment.js
```

`decide` is a pure function: a subscription is rescheduled only when it is Active, its next payment date is in the past, and no renewal is already in progress for it at Stripe. The new date is computed from the subscription's own billing period and interval, never guessed. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest active-sub-with-a-past-next-payment-date/python
node --test active-sub-with-a-past-next-payment-date/node
```
