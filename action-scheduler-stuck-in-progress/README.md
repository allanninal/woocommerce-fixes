# Action Scheduler stuck in-progress

An Action Scheduler action normally moves from pending, to in-progress, to complete within seconds. When the PHP worker that claimed an action dies mid run (a timeout, an out of memory kill, a fatal error), the action is left on in-progress forever. That stuck action can block its group or hook from being claimed again, and for a subscription renewal or payment retry it also means nobody knows if Stripe actually took the money. This job reads a small export of stuck actions, checks Stripe for the truth about the linked order's PaymentIntent, and decides whether to finish the order, flag the action safe to reset, or leave it alone because money is still in flight.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/action-scheduler-stuck-in-progress/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export STUCK_AFTER_MINUTES="30"
export DRY_RUN="true"

# Export the stuck actions first, then add order_id / orderId per hook args
wp action-scheduler action list --status=in-progress --format=json > stuck.json

python action-scheduler-stuck-in-progress/python/audit_stuck_actions.py stuck.json
node   action-scheduler-stuck-in-progress/node/audit-stuck-actions.js stuck.json
```

`decide` is a pure function: it never touches the network. Given an action's status and age, an order (or none), and a Stripe PaymentIntent (or none), it returns one of `complete_order`, `reset_action`, `wait`, or `investigate`. It never acts on an action that has not been stuck past `STUCK_AFTER_MINUTES`, and it never touches an order while Stripe still shows the payment in flight. Start with `DRY_RUN=true` to review the plan before it writes anything.

## Test

```bash
pytest action-scheduler-stuck-in-progress/python
node --test action-scheduler-stuck-in-progress/node
```
