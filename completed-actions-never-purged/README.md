# Completed actions never purged

Action Scheduler's own daily cleanup should remove old completed and canceled actions, but it depends on WP-Cron firing reliably and a batch size that can keep up with the store's volume. When it falls behind, both the `actionscheduler_actions` table and ad hoc reconciliation meta written onto orders by past webhook-repair and payment-verification scripts pile up forever. This job walks settled orders past a retention window, re-confirms the linked Stripe PaymentIntent, and only purges the stale meta once Stripe still agrees the order is genuinely paid and settled.

**Full guide:** https://www.allanninal.dev/woocommerce/completed-actions-never-purged/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export RETENTION_DAYS="90"
export DRY_RUN="true"

python completed-actions-never-purged/python/purge_completed_meta.py
node   completed-actions-never-purged/node/purge-completed-meta.js
```

`decide` is a pure function: an order's stale reconciliation meta is only purged once the order is settled, past the retention window, and Stripe still confirms the linked PaymentIntent as succeeded with the right amount. It never touches the order itself, only leftover meta keys, and it is read only by default. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest completed-actions-never-purged/python
node --test completed-actions-never-purged/node
```
