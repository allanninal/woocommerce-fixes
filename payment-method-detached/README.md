# Payment method detached

A saved card lives on Stripe as a PaymentMethod attached to a Customer. If that PaymentMethod gets detached, by the shopper removing it in a self-service portal, by a cleanup script that ran against the wrong customer, or by a support agent clearing "duplicate" cards, the next renewal fails with a generic decline and the subscription goes on-hold. Stripe will not let you reattach a PaymentMethod once it is detached, so this job only detects the problem, by reading the PaymentIntent from the latest renewal order and checking whether the PaymentMethod it tried to charge is still attached to the right Stripe customer, and flags the subscription so a human can ask the shopper for a new card.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/payment-method-detached/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"

python payment-method-detached/python/find_detached_payment_methods.py
node   payment-method-detached/node/find-detached-payment-methods.js
```

`decide` is a pure function: a subscription is flagged only when its latest renewal order names a PaymentIntent whose payment_method is missing, detached from any customer, or attached to the wrong customer. It is read only by default, it only adds a note and puts the subscription on-hold for review. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest payment-method-detached/python
node --test payment-method-detached/node
```
