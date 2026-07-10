# Action Scheduler tables balloon

Action Scheduler (the job queue WooCommerce, WooCommerce Subscriptions, and most extensions run on) keeps a full history of every action it has ever run. WordPress core only claims to purge actions older than 30 days once a day, and one blocked or failing cron run is enough for that housekeeping job to stop firing, so `wp_actionscheduler_actions` and `wp_actionscheduler_logs` just keep growing until the database is slow and backups take forever. This job reports the current table sizes and finds old completed or failed actions that are safe to purge, cross-checking each related order against Stripe first so nothing gets deleted for an order whose payment is not actually finished.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/action-scheduler-tables-balloon/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export RETENTION_DAYS="30"
export ROW_COUNT_ALERT="50000"
export DRY_RUN="true"

python action-scheduler-tables-balloon/python/audit_action_scheduler.py
node   action-scheduler-tables-balloon/node/audit-action-scheduler.js
```

`decide` is a pure function: an action group is only purged once it is complete, older than `RETENTION_DAYS`, and its order (if any) is closed with a Stripe payment that is also in a closed state. It is read only by default (it just logs a report and adds an order note). Start with `DRY_RUN=true` to review the plan first.

## Test

```bash
pytest action-scheduler-tables-balloon/python
node --test action-scheduler-tables-balloon/node/*.test.js
```
