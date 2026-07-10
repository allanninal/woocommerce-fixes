# Timezone-corrupted next payment dates

A local timezone plugin, a server timezone change, or a hand edit to a subscription's schedule meta can save the site's local wall clock time into the UTC next payment date field instead of true UTC. The stored date then sits hours away from where it should be, which makes Action Scheduler fire the renewal early, fire it twice in one day around a daylight saving change, or leave the subscription looking overdue when it is not. This job reads each active subscription's saved next payment date, works out the correct UTC date from the last paid renewal and the billing schedule, and repairs any date that is off by a clean multiple of the site's UTC offset. Anything that does not line up with a clean offset is flagged for a human instead of guessed at.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/timezone-corrupted-next-payment-dates/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export SITE_UTC_OFFSET_HOURS="8"   # your site's UTC offset, used to confirm a clean timezone drift
export MAX_OFFSET_MULTIPLE="2"     # how many multiples of the offset count as a clean repair
export TOLERANCE_MINUTES="5"
export DRY_RUN="true"              # start safe, change to false to write

python timezone-corrupted-next-payment-dates/python/fix_next_payment_timezone.py
node   timezone-corrupted-next-payment-dates/node/fix-next-payment-timezone.js
```

`decide` is a pure function: it compares the subscription's saved next payment date to the expected date computed from the last paid renewal, and only repairs a date whose drift matches a clean multiple of the site's UTC offset within tolerance. Anything else is flagged, not touched. It is safe by default, `DRY_RUN=true` only reports what it would repair.

## Test

```bash
pytest timezone-corrupted-next-payment-dates/python
node --test timezone-corrupted-next-payment-dates/node
```
