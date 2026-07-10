# iDEAL and Bancontact for renewals

A subscription's first payment can go through cleanly on iDEAL or Bancontact, but both are one off, redirect based payment methods that Stripe never attaches as a reusable payment method to the customer. WooCommerce Subscriptions has nothing to charge automatically when the renewal date arrives. This job walks active subscriptions with a renewal coming up soon, reads the PaymentIntent behind the first order, and flags any subscription that is still stuck on a one off method with no reusable card on file, by adding an order note so a human can ask the customer to add a card before the renewal is attempted.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/ideal-and-bancontact-for-renewals/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export RENEWAL_WINDOW_DAYS="7"
export DRY_RUN="true"

python ideal-and-bancontact-for-renewals/python/check_one_off_methods.py
node   ideal-and-bancontact-for-renewals/node/check-one-off-methods.js
```

`decide` is a pure function: a subscription is flagged only when its first payment used iDEAL or Bancontact, no reusable card is on file for the customer, and the next renewal is inside the configured window. It is read only by default (it just adds a note). Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest ideal-and-bancontact-for-renewals/python
node --test ideal-and-bancontact-for-renewals/node
```
