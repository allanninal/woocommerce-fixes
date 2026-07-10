# Add off session mandate to old subs

Subscriptions created before Strong Customer Authentication (SCA) became the norm often saved a card as a plain Stripe Source, or as a PaymentMethod that was only ever confirmed while the shopper was on the checkout page. Stripe requires an off session mandate before it will let a merchant charge a saved PaymentMethod without the customer present, so the next renewal comes back `requires_action` and the subscription goes on-hold. This job walks active subscriptions, reads the saved PaymentMethod from the parent order, and for any PaymentMethod with no prior off session confirmation, runs a zero amount off session SetupIntent to attach a mandate that every future renewal can reuse.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/add-off-session-mandate-to-old-subs/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"

python add-off-session-mandate-to-old-subs/python/attach_off_session_mandate.py
node   add-off-session-mandate-to-old-subs/node/attach-off-session-mandate.js
```

`decide` is a pure function: a subscription needs a mandate only when it is active or on-hold, its PaymentMethod supports off session use, and no prior off session SetupIntent has succeeded for that PaymentMethod. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest add-off-session-mandate-to-old-subs/python
node --test add-off-session-mandate-to-old-subs/node
```
