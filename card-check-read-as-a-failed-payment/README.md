# Card check read as a failed payment

Stripe sometimes verifies a saved card with a zero amount PaymentIntent, for example after a card updater event or a trial signup, rather than charging anything. If that check does not come back clean, some failure handling treats it exactly like a declined renewal charge, putting the subscription on hold and sending dunning emails for a payment that was never actually attempted. This job walks recently dunned subscriptions, reads the PaymentIntent behind the last order, and reactivates any subscription whose "failure" was really a zero amount check, leaving real declines untouched.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/card-check-read-as-a-failed-payment/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="3"
export DRY_RUN="true"

python card-check-read-as-a-failed-payment/python/card_check_auditor.py
node   card-check-read-as-a-failed-payment/node/card-check-auditor.js
```

`decide` is a pure function: a subscription is only restored when it is in a dunned state and the linked Stripe PaymentIntent shows an amount of 0, proving no money was ever requested. Real declines with a real amount are left alone. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest card-check-read-as-a-failed-payment/python
node --test card-check-read-as-a-failed-payment/node
```
