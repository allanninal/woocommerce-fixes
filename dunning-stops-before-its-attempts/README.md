# Dunning stops before its attempts

WooCommerce Subscriptions retries a failed renewal on a schedule, for example one day, then three days, then five days after the first decline, and only gives up once every configured attempt has actually run. Sometimes that schedule dies early: a cron miss, a paused Action Scheduler queue, or a worker that throws before it books the next retry. The subscription is left on-hold with attempts still unused, and nothing ever tries the card again. This job finds subscriptions like that, waits out the normal gap between attempts, and if the schedule has genuinely gone quiet, charges the next attempt itself using the saved Stripe payment method and records what happened.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/dunning-stops-before-its-attempts/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DUNNING_MAX_ATTEMPTS="3"
export DUNNING_STALL_HOURS="36"
export DRY_RUN="true"

python dunning-stops-before-its-attempts/python/resume_dunning.py
node   dunning-stops-before-its-attempts/node/resume-dunning.js
```

`decide` is a pure function: a subscription is only resumed when it is on-hold, has a renewal order to retry, has not used up every configured attempt, and has gone quiet well past the normal wait between attempts. Start with `DRY_RUN=true` to see the exact list before it charges anything.

## Test

```bash
pytest dunning-stops-before-its-attempts/python
node --test dunning-stops-before-its-attempts/node
```
