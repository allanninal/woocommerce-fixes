# WooCommerce Fixes

Small, tested Python and Node.js scripts that detect and repair real problems across **WooCommerce**, **WooCommerce Subscriptions**, and the **WooCommerce Stripe** gateway. Stuck orders, lost webhooks, double charges, broken renewals, token and migration issues, and more.

Every fix is safe by default. The scripts start in a dry run mode that reports what they would do, so you can read the plan before anything writes.

By **[Allan Niñal](https://github.com/allanninal)** — AI Solutions Engineer. I build AI powered tools, data products, and AWS automation.
Full write ups with diagrams for each fix live at **[allanninal.dev/woocommerce](https://www.allanninal.dev/woocommerce/)**.

[![Follow on GitHub](https://img.shields.io/github/followers/allanninal?label=Follow%20%40allanninal&style=social)](https://github.com/allanninal)
[![Tests](https://github.com/allanninal/woocommerce-fixes/actions/workflows/tests.yml/badge.svg)](https://github.com/allanninal/woocommerce-fixes/actions/workflows/tests.yml)

## How the scripts work

Most fixes talk to two systems:

- **Stripe**, through the official SDK (`stripe` for Python, `stripe` for Node).
- **WooCommerce**, through the REST API, so everything works the same on stores that use High Performance Order Storage.

The link between the two is usually the same. Stripe objects carry `metadata.order_id`, and WooCommerce orders carry `_stripe_intent_id`, `_stripe_charge_id`, and `_transaction_id`. Some fixes touch WooCommerce or WooCommerce Subscriptions on their own, with no Stripe call at all.

## Setup

Set the environment variables a fix needs. Create the WooCommerce key pair under WooCommerce, Settings, Advanced, REST API.

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"   # start safe
```

Python needs `pip install stripe requests`. Node needs `npm install stripe` and Node 18 or newer.

## The fixes

| Fix | What it does | Type | Guide |
|---|---|---|---|
| [paid-orders-stuck-on-pending](./paid-orders-stuck-on-pending/) | Finish paid orders the webhook missed | Reconciler | [Read](https://www.allanninal.dev/woocommerce/paid-orders-stuck-on-pending/) |
| [missing-intent-id-webhook-cannot-match-order](./missing-intent-id-webhook-cannot-match-order/) | Recover the lost PaymentIntent ID and backfill it | Repair | [Read](https://www.allanninal.dev/woocommerce/missing-intent-id-webhook-cannot-match-order/) |
| [stripe-webhook-not-delivered-configuration](./stripe-webhook-not-delivered-configuration/) | Check the webhook endpoint and its deliveries | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/stripe-webhook-not-delivered-configuration/) |
| [duplicate-charge-redirect-webhook-race](./duplicate-charge-redirect-webhook-race/) | Find double charges and refund the extra | Reconciler | [Read](https://www.allanninal.dev/woocommerce/duplicate-charge-redirect-webhook-race/) |
| [stripe-webhook-signing-secret-mismatch](./stripe-webhook-signing-secret-mismatch/) | Find the signing secret mismatch that rejects every webhook | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/stripe-webhook-signing-secret-mismatch/) |
| [stripe-dashboard-refund-not-synced](./stripe-dashboard-refund-not-synced/) | Record Stripe dashboard refunds missing from WooCommerce | Reconciler | [Read](https://www.allanninal.dev/woocommerce/stripe-dashboard-refund-not-synced/) |
| [orders-stuck-requires-action-3ds](./orders-stuck-requires-action-3ds/) | Resolve orders stuck on 3D Secure, free held stock | Reconciler | [Read](https://www.allanninal.dev/woocommerce/orders-stuck-requires-action-3ds/) |
| [subscription-on-hold-after-successful-renewal](./subscription-on-hold-after-successful-renewal/) | Reactivate subscriptions paid but stuck On-Hold (HPOS) | Reconciler | [Read](https://www.allanninal.dev/woocommerce/subscription-on-hold-after-successful-renewal/) |
| [declined-card-order-stuck-pending](./declined-card-order-stuck-pending/) | Fail declined-card orders left on Pending, free stock | Repair | [Read](https://www.allanninal.dev/woocommerce/declined-card-order-stuck-pending/) |
| [subscription-missing-saved-card-token](./subscription-missing-saved-card-token/) | Recover the lost Stripe card so renewals work again | Reconciler | [Read](https://www.allanninal.dev/woocommerce/subscription-missing-saved-card-token/) |
| [cancel-abandoned-payment-intents](./cancel-abandoned-payment-intents/) | Cancel abandoned PaymentIntents and their pending orders | Reconciler | [Read](https://www.allanninal.dev/woocommerce/cancel-abandoned-payment-intents/) |
| [refund-webhook-skips-non-card-methods](./refund-webhook-skips-non-card-methods/) | Record refunds on iDEAL/EPS/SEPA the webhook skipped | Repair | [Read](https://www.allanninal.dev/woocommerce/refund-webhook-skips-non-card-methods/) |
| [stripe-fee-net-stale-after-refund](./stripe-fee-net-stale-after-refund/) | Recompute stale Stripe fee and net after a refund | Repair | [Read](https://www.allanninal.dev/woocommerce/stripe-fee-net-stale-after-refund/) |
| [replay-missed-stripe-webhook-events](./replay-missed-stripe-webhook-events/) | Replay Stripe events missed during downtime | Reconciler | [Read](https://www.allanninal.dev/woocommerce/replay-missed-stripe-webhook-events/) |
| [new-card-not-linked-to-subscription](./new-card-not-linked-to-subscription/) | Repoint a subscription to the customer's current card | Reconciler | [Read](https://www.allanninal.dev/woocommerce/new-card-not-linked-to-subscription/) |
| [authorized-charges-never-captured](./authorized-charges-never-captured/) | Capture on-hold orders before the Stripe auth expires | Reconciler | [Read](https://www.allanninal.dev/woocommerce/authorized-charges-never-captured/) |
| [late-failure-reverts-paid-order](./late-failure-reverts-paid-order/) | Restore paid orders a late failure event reverted | Reconciler | [Read](https://www.allanninal.dev/woocommerce/late-failure-reverts-paid-order/) |
| [order-marked-paid-no-charge](./order-marked-paid-no-charge/) | Flag paid orders with no matching Stripe charge | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/order-marked-paid-no-charge/) |
| [overselling-race-stock-negative](./overselling-race-stock-negative/) | Reset products/variations that oversold below zero | Repair | [Read](https://www.allanninal.dev/woocommerce/overselling-race-stock-negative/) |
| [subscriptions-revert-to-manual-renewal](./subscriptions-revert-to-manual-renewal/) | Restore auto renewal for tokened subs stuck on manual | Repair | [Read](https://www.allanninal.dev/woocommerce/subscriptions-revert-to-manual-renewal/) |
| [record-stripe-fees-on-orders](./record-stripe-fees-on-orders/) | Save the real Stripe fee and net on each order | Reconciler | [Read](https://www.allanninal.dev/woocommerce/record-stripe-fees-on-orders/) |
| [action-scheduler-stuck-in-progress](./action-scheduler-stuck-in-progress/) | Action Scheduler stuck in-progress | Repair | [Read](https://www.allanninal.dev/woocommerce/action-scheduler-stuck-in-progress/) |
| [action-scheduler-tables-balloon](./action-scheduler-tables-balloon/) | Action Scheduler tables balloon | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/action-scheduler-tables-balloon/) |
| [active-sub-with-a-past-next-payment-date](./active-sub-with-a-past-next-payment-date/) | Active sub with a past next payment date | Repair | [Read](https://www.allanninal.dev/woocommerce/active-sub-with-a-past-next-payment-date/) |
| [active-subscriber-counts-wrong-in-reports](./active-subscriber-counts-wrong-in-reports/) | Active subscriber counts wrong in reports | Reconciler | [Read](https://www.allanninal.dev/woocommerce/active-subscriber-counts-wrong-in-reports/) |
| [add-off-session-mandate-to-old-subs](./add-off-session-mandate-to-old-subs/) | Add off session mandate to old subs | Repair | [Read](https://www.allanninal.dev/woocommerce/add-off-session-mandate-to-old-subs/) |
| [amount-does-not-match-the-order](./amount-does-not-match-the-order/) | Amount does not match the order | Reconciler | [Read](https://www.allanninal.dev/woocommerce/amount-does-not-match-the-order/) |
| [attach-the-payment-method](./attach-the-payment-method/) | Attach the payment method | Repair | [Read](https://www.allanninal.dev/woocommerce/attach-the-payment-method/) |
| [attribute-and-term-counts-drift](./attribute-and-term-counts-drift/) | Attribute and term counts drift | Repair | [Read](https://www.allanninal.dev/woocommerce/attribute-and-term-counts-drift/) |
| [autoloaded-options-bloat](./autoloaded-options-bloat/) | Autoloaded options bloat | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/autoloaded-options-bloat/) |
| [backfill-order-id-metadata](./backfill-order-id-metadata/) | Backfill order ID metadata | Repair | [Read](https://www.allanninal.dev/woocommerce/backfill-order-id-metadata/) |
| [billing-runs-after-woopayments-off](./billing-runs-after-woopayments-off/) | Billing runs after WooPayments off | Repair | [Read](https://www.allanninal.dev/woocommerce/billing-runs-after-woopayments-off/) |
| [broken-featured-images](./broken-featured-images/) | Broken featured images | Repair | [Read](https://www.allanninal.dev/woocommerce/broken-featured-images/) |
| [bulk-cancel-and-keep-in-sync](./bulk-cancel-and-keep-in-sync/) | Bulk cancel and keep in sync | Reconciler | [Read](https://www.allanninal.dev/woocommerce/bulk-cancel-and-keep-in-sync/) |
| [bulk-pause-on-both-systems](./bulk-pause-on-both-systems/) | Bulk pause on both systems | Repair | [Read](https://www.allanninal.dev/woocommerce/bulk-pause-on-both-systems/) |
| [bulk-subscription-export-runs-out-of-memory](./bulk-subscription-export-runs-out-of-memory/) | Bulk subscription export runs out of memory | Repair | [Read](https://www.allanninal.dev/woocommerce/bulk-subscription-export-runs-out-of-memory/) |
| [bulk-swap-a-reissued-card-range](./bulk-swap-a-reissued-card-range/) | Bulk swap a reissued card range | Repair | [Read](https://www.allanninal.dev/woocommerce/bulk-swap-a-reissued-card-range/) |
| [cannot-change-the-card-twice](./cannot-change-the-card-twice/) | Cannot change the card twice | Repair | [Read](https://www.allanninal.dev/woocommerce/cannot-change-the-card-twice/) |
| [cannot-reactivate-a-pending-cancel-sub](./cannot-reactivate-a-pending-cancel-sub/) | Cannot reactivate a pending-cancel sub | Repair | [Read](https://www.allanninal.dev/woocommerce/cannot-reactivate-a-pending-cancel-sub/) |
| [card-change-flips-sub-to-pending](./card-change-flips-sub-to-pending/) | Card change flips the subscription to Pending | Reconciler | [Read](https://www.allanninal.dev/woocommerce/card-change-flips-sub-to-pending/) |
| [card-check-read-as-a-failed-payment](./card-check-read-as-a-failed-payment/) | Card check read as a failed payment | Repair | [Read](https://www.allanninal.dev/woocommerce/card-check-read-as-a-failed-payment/) |
| [card-not-saved-for-future-renewals](./card-not-saved-for-future-renewals/) | Card not saved for future renewals | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/card-not-saved-for-future-renewals/) |
| [checkout-draft-orders-pile-up](./checkout-draft-orders-pile-up/) | Checkout-draft orders pile up | Repair | [Read](https://www.allanninal.dev/woocommerce/checkout-draft-orders-pile-up/) |
| [clear-transients-tool-leaves-residue](./clear-transients-tool-leaves-residue/) | Clear transients tool leaves residue | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/clear-transients-tool-leaves-residue/) |
| [completed-actions-never-purged](./completed-actions-never-purged/) | Completed actions never purged | Repair | [Read](https://www.allanninal.dev/woocommerce/completed-actions-never-purged/) |
| [coupon-expiry-uses-utc-not-site-time](./coupon-expiry-uses-utc-not-site-time/) | Coupon expiry uses UTC not site time | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/coupon-expiry-uses-utc-not-site-time/) |
| [coupon-usage-count-undercounts](./coupon-usage-count-undercounts/) | Coupon usage count undercounts | Reconciler | [Read](https://www.allanninal.dev/woocommerce/coupon-usage-count-undercounts/) |
| [coupon-usage-counted-twice-via-rest](./coupon-usage-counted-twice-via-rest/) | Coupon usage counted twice via REST | Repair | [Read](https://www.allanninal.dev/woocommerce/coupon-usage-counted-twice-via-rest/) |
| [currency-not-enabled-on-stripe](./currency-not-enabled-on-stripe/) | Currency not enabled on Stripe | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/currency-not-enabled-on-stripe/) |
| [customer-lifetime-value-drifts](./customer-lifetime-value-drifts/) | Customer lifetime value drifts | Reconciler | [Read](https://www.allanninal.dev/woocommerce/customer-lifetime-value-drifts/) |
| [customer-lookup-out-of-sync](./customer-lookup-out-of-sync/) | Customer lookup out of sync | Reconciler | [Read](https://www.allanninal.dev/woocommerce/customer-lookup-out-of-sync/) |
| [deleting-a-variation-does-not-resync-the-parent](./deleting-a-variation-does-not-resync-the-parent/) | Deleting a variation does not resync the parent | Repair | [Read](https://www.allanninal.dev/woocommerce/deleting-a-variation-does-not-resync-the-parent/) |
| [detect-test-vs-live-key-mixups](./detect-test-vs-live-key-mixups/) | Detect test vs live key mixups | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/detect-test-vs-live-key-mixups/) |
| [disputes-not-recorded-on-the-order](./disputes-not-recorded-on-the-order/) | Disputes not recorded on the order | Reconciler | [Read](https://www.allanninal.dev/woocommerce/disputes-not-recorded-on-the-order/) |
| [double-stock-reduction](./double-stock-reduction/) | Double stock reduction | Repair | [Read](https://www.allanninal.dev/woocommerce/double-stock-reduction/) |
| [dunning-stops-before-its-attempts](./dunning-stops-before-its-attempts/) | Dunning stops before its attempts | Reconciler | [Read](https://www.allanninal.dev/woocommerce/dunning-stops-before-its-attempts/) |
| [duplicate-customer-accounts-at-checkout](./duplicate-customer-accounts-at-checkout/) | Duplicate customer accounts at checkout | Reconciler | [Read](https://www.allanninal.dev/woocommerce/duplicate-customer-accounts-at-checkout/) |
| [duplicate-customers-for-one-email](./duplicate-customers-for-one-email/) | Duplicate customers for one email | Repair | [Read](https://www.allanninal.dev/woocommerce/duplicate-customers-for-one-email/) |
| [duplicate-or-missing-skus](./duplicate-or-missing-skus/) | Duplicate or missing SKUs | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/duplicate-or-missing-skus/) |
| [duplicate-renewal-orders-in-one-cycle](./duplicate-renewal-orders-in-one-cycle/) | Duplicate renewal orders in one cycle | Repair | [Read](https://www.allanninal.dev/woocommerce/duplicate-renewal-orders-in-one-cycle/) |
| [duplicate-saved-cards](./duplicate-saved-cards/) | Duplicate saved cards | Repair | [Read](https://www.allanninal.dev/woocommerce/duplicate-saved-cards/) |
| [duplicate-webhook-events](./duplicate-webhook-events/) | Duplicate webhook events | Repair | [Read](https://www.allanninal.dev/woocommerce/duplicate-webhook-events/) |
| [early-renewal-shifts-the-billing-cadence](./early-renewal-shifts-the-billing-cadence/) | Early renewal shifts the billing cadence | Repair | [Read](https://www.allanninal.dev/woocommerce/early-renewal-shifts-the-billing-cadence/) |
| [expired-sale-prices-never-revert](./expired-sale-prices-never-revert/) | Expired sale prices never revert | Repair | [Read](https://www.allanninal.dev/woocommerce/expired-sale-prices-never-revert/) |
| [expired-transients-bloat-wp-options](./expired-transients-bloat-wp-options/) | Expired transients bloat wp_options | Repair | [Read](https://www.allanninal.dev/woocommerce/expired-transients-bloat-wp-options/) |
| [failed-order-reduces-stock-never-restored](./failed-order-reduces-stock-never-restored/) | Failed order reduces stock, never restored | Repair | [Read](https://www.allanninal.dev/woocommerce/failed-order-reduces-stock-never-restored/) |
| [failed-orders-inflate-and-lock-coupons](./failed-orders-inflate-and-lock-coupons/) | Failed orders inflate and lock coupons | Repair | [Read](https://www.allanninal.dev/woocommerce/failed-orders-inflate-and-lock-coupons/) |
| [fee-and-net-missing-on-renewals](./fee-and-net-missing-on-renewals/) | Fee and net missing on renewals | Repair | [Read](https://www.allanninal.dev/woocommerce/fee-and-net-missing-on-renewals/) |
| [free-trials-forced-to-manual-renewal](./free-trials-forced-to-manual-renewal/) | Free trials forced to manual renewal | Repair | [Read](https://www.allanninal.dev/woocommerce/free-trials-forced-to-manual-renewal/) |
| [guest-orders-not-linked-to-accounts](./guest-orders-not-linked-to-accounts/) | Guest orders not linked to accounts | Repair | [Read](https://www.allanninal.dev/woocommerce/guest-orders-not-linked-to-accounts/) |
| [hpos-schedule-divergence](./hpos-schedule-divergence/) | HPOS schedule divergence | Reconciler | [Read](https://www.allanninal.dev/woocommerce/hpos-schedule-divergence/) |
| [ideal-and-bancontact-for-renewals](./ideal-and-bancontact-for-renewals/) | iDEAL and Bancontact for renewals | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/ideal-and-bancontact-for-renewals/) |
| [idempotency-gap-on-paymentintents](./idempotency-gap-on-paymentintents/) | Idempotency gap on PaymentIntents | Repair | [Read](https://www.allanninal.dev/woocommerce/idempotency-gap-on-paymentintents/) |
| [import-cards-from-another-processor](./import-cards-from-another-processor/) | Import cards from another processor | Reconciler | [Read](https://www.allanninal.dev/woocommerce/import-cards-from-another-processor/) |
| [invisible-auto-draft-orders](./invisible-auto-draft-orders/) | Invisible auto-draft orders | Repair | [Read](https://www.allanninal.dev/woocommerce/invisible-auto-draft-orders/) |
| [legacy-order-rows-survive-after-hpos-cleanup](./legacy-order-rows-survive-after-hpos-cleanup/) | Legacy order rows survive after HPOS cleanup | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/legacy-order-rows-survive-after-hpos-cleanup/) |
| [legacy-to-new-checkout-cards](./legacy-to-new-checkout-cards/) | Legacy to new checkout cards | Repair | [Read](https://www.allanninal.dev/woocommerce/legacy-to-new-checkout-cards/) |
| [limited-payment-coupon-miscounts](./limited-payment-coupon-miscounts/) | Limited-payment coupon miscounts | Reconciler | [Read](https://www.allanninal.dev/woocommerce/limited-payment-coupon-miscounts/) |
| [match-payouts-to-orders](./match-payouts-to-orders/) | Match payouts to orders | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/match-payouts-to-orders/) |
| [move-sources-to-payment-methods](./move-sources-to-payment-methods/) | Move sources to payment methods | Repair | [Read](https://www.allanninal.dev/woocommerce/move-sources-to-payment-methods/) |
| [move-woopayments-to-stripe](./move-woopayments-to-stripe/) | Move WooPayments to Stripe | Repair | [Read](https://www.allanninal.dev/woocommerce/move-woopayments-to-stripe/) |
| [next-payment-date-drifts-after-a-late-renewal](./next-payment-date-drifts-after-a-late-renewal/) | Next payment date drifts after a late renewal | Repair | [Read](https://www.allanninal.dev/woocommerce/next-payment-date-drifts-after-a-late-renewal/) |
| [old-sepa-sources-rejected](./old-sepa-sources-rejected/) | Old SEPA sources rejected | Reconciler | [Read](https://www.allanninal.dev/woocommerce/old-sepa-sources-rejected/) |
| [on-sale-flag-shows-products-not-on-sale](./on-sale-flag-shows-products-not-on-sale/) | On sale flag shows products not on sale | Repair | [Read](https://www.allanninal.dev/woocommerce/on-sale-flag-shows-products-not-on-sale/) |
| [order-edits-do-not-adjust-stock](./order-edits-do-not-adjust-stock/) | Order edits do not adjust stock | Reconciler | [Read](https://www.allanninal.dev/woocommerce/order-edits-do-not-adjust-stock/) |
| [order-stats-wrong-after-hpos-migration](./order-stats-wrong-after-hpos-migration/) | Order stats wrong after HPOS migration | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/order-stats-wrong-after-hpos-migration/) |
| [order-tax-off-by-a-cent-frontend-vs-api](./order-tax-off-by-a-cent-frontend-vs-api/) | Order tax off by a cent (frontend vs API) | Reconciler | [Read](https://www.allanninal.dev/woocommerce/order-tax-off-by-a-cent-frontend-vs-api/) |
| [orphaned-customers-and-cards](./orphaned-customers-and-cards/) | Orphaned customers and cards | Repair | [Read](https://www.allanninal.dev/woocommerce/orphaned-customers-and-cards/) |
| [orphaned-postmeta-rows](./orphaned-postmeta-rows/) | Orphaned postmeta rows | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/orphaned-postmeta-rows/) |
| [orphaned-product-variations](./orphaned-product-variations/) | Orphaned product variations | Repair | [Read](https://www.allanninal.dev/woocommerce/orphaned-product-variations/) |
| [orphaned-subscriptions-with-no-customer](./orphaned-subscriptions-with-no-customer/) | Orphaned subscriptions with no customer | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/orphaned-subscriptions-with-no-customer/) |
| [out-of-stock-but-still-purchasable](./out-of-stock-but-still-purchasable/) | Out of stock but still purchasable | Repair | [Read](https://www.allanninal.dev/woocommerce/out-of-stock-but-still-purchasable/) |
| [partial-capture-total-mismatch](./partial-capture-total-mismatch/) | Partial capture total mismatch | Repair | [Read](https://www.allanninal.dev/woocommerce/partial-capture-total-mismatch/) |
| [partial-refund-gives-back-everything](./partial-refund-gives-back-everything/) | Partial refund gives back everything | Repair | [Read](https://www.allanninal.dev/woocommerce/partial-refund-gives-back-everything/) |
| [payment-method-detached](./payment-method-detached/) | Payment method detached | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/payment-method-detached/) |
| [persistent-cart-data-never-cleared](./persistent-cart-data-never-cleared/) | Persistent cart data never cleared | Repair | [Read](https://www.allanninal.dev/woocommerce/persistent-cart-data-never-cleared/) |
| [popularity-sort-uses-stale-total-sales](./popularity-sort-uses-stale-total-sales/) | Popularity sort uses stale total_sales | Repair | [Read](https://www.allanninal.dev/woocommerce/popularity-sort-uses-stale-total-sales/) |
| [presentment-vs-settlement-currency](./presentment-vs-settlement-currency/) | Presentment vs settlement currency | Repair | [Read](https://www.allanninal.dev/woocommerce/presentment-vs-settlement-currency/) |
| [product-lookup-table-out-of-sync](./product-lookup-table-out-of-sync/) | Product lookup table out of sync | Repair | [Read](https://www.allanninal.dev/woocommerce/product-lookup-table-out-of-sync/) |
| [product-visibility-terms-mis-assigned](./product-visibility-terms-mis-assigned/) | Product visibility terms mis-assigned | Repair | [Read](https://www.allanninal.dev/woocommerce/product-visibility-terms-mis-assigned/) |
| [products-stranded-with-no-category](./products-stranded-with-no-category/) | Products stranded with no category | Repair | [Read](https://www.allanninal.dev/woocommerce/products-stranded-with-no-category/) |
| [promote-the-default-source](./promote-the-default-source/) | Promote the default source | Repair | [Read](https://www.allanninal.dev/woocommerce/promote-the-default-source/) |
| [proration-miscalculated-on-a-second-switch](./proration-miscalculated-on-a-second-switch/) | Proration miscalculated on a second switch | Reconciler | [Read](https://www.allanninal.dev/woocommerce/proration-miscalculated-on-a-second-switch/) |
| [push-a-card-change-to-stripe](./push-a-card-change-to-stripe/) | Push a card change to Stripe | Repair | [Read](https://www.allanninal.dev/woocommerce/push-a-card-change-to-stripe/) |
| [ratings-count-drifts-from-real-reviews](./ratings-count-drifts-from-real-reviews/) | Ratings count drifts from real reviews | Repair | [Read](https://www.allanninal.dev/woocommerce/ratings-count-drifts-from-real-reviews/) |
| [recreate-subs-after-account-move](./recreate-subs-after-account-move/) | Recreate subs after account move | Repair | [Read](https://www.allanninal.dev/woocommerce/recreate-subs-after-account-move/) |
| [recurring-coupon-dropped-on-switch](./recurring-coupon-dropped-on-switch/) | Recurring coupon dropped on switch | Repair | [Read](https://www.allanninal.dev/woocommerce/recurring-coupon-dropped-on-switch/) |
| [refund-and-dispute-double-reversal](./refund-and-dispute-double-reversal/) | Refund and dispute double reversal | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/refund-and-dispute-double-reversal/) |
| [remap-customers-after-a-store-move](./remap-customers-after-a-store-move/) | Remap customers after a store move | Repair | [Read](https://www.allanninal.dev/woocommerce/remap-customers-after-a-store-move/) |
| [remove-test-ids-from-live](./remove-test-ids-from-live/) | Remove test IDs from live | Repair | [Read](https://www.allanninal.dev/woocommerce/remove-test-ids-from-live/) |
| [renewal-actions-stall-no-renewals-made](./renewal-actions-stall-no-renewals-made/) | Renewal actions stall, no renewals made | Reconciler | [Read](https://www.allanninal.dev/woocommerce/renewal-actions-stall-no-renewals-made/) |
| [renewal-charged-no-order-made](./renewal-charged-no-order-made/) | Renewal charged, no order made | Repair | [Read](https://www.allanninal.dev/woocommerce/renewal-charged-no-order-made/) |
| [renewal-marked-paid-with-no-payment](./renewal-marked-paid-with-no-payment/) | Renewal marked paid with no payment | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/renewal-marked-paid-with-no-payment/) |
| [renewals-never-run](./renewals-never-run/) | Renewals never run | Repair | [Read](https://www.allanninal.dev/woocommerce/renewals-never-run/) |
| [rest-pagination-breaks-on-large-sets](./rest-pagination-breaks-on-large-sets/) | REST pagination breaks on large sets | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/rest-pagination-breaks-on-large-sets/) |
| [rounding-drifts-the-order-total-by-a-cent](./rounding-drifts-the-order-total-by-a-cent/) | Rounding drifts the order total by a cent | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/rounding-drifts-the-order-total-by-a-cent/) |
| [sepa-renewal-stays-active-on-fail](./sepa-renewal-stays-active-on-fail/) | SEPA renewal stays active on fail | Repair | [Read](https://www.allanninal.dev/woocommerce/sepa-renewal-stays-active-on-fail/) |
| [sepa-subs-flip-to-manual-renewal](./sepa-subs-flip-to-manual-renewal/) | SEPA subs flip to manual renewal | Repair | [Read](https://www.allanninal.dev/woocommerce/sepa-subs-flip-to-manual-renewal/) |
| [session-table-balloons](./session-table-balloons/) | Session table balloons | Repair | [Read](https://www.allanninal.dev/woocommerce/session-table-balloons/) |
| [slow-methods-succeed-but-never-match](./slow-methods-succeed-but-never-match/) | Slow methods succeed but never match | Reconciler | [Read](https://www.allanninal.dev/woocommerce/slow-methods-succeed-but-never-match/) |
| [staging-site-pauses-live-subs](./staging-site-pauses-live-subs/) | Staging site pauses live subs | Repair | [Read](https://www.allanninal.dev/woocommerce/staging-site-pauses-live-subs/) |
| [stale-ids-after-a-gateway-switch](./stale-ids-after-a-gateway-switch/) | Stale IDs after a gateway switch | Repair | [Read](https://www.allanninal.dev/woocommerce/stale-ids-after-a-gateway-switch/) |
| [stale-reserved-stock-rows-oversell](./stale-reserved-stock-rows-oversell/) | Stale reserved-stock rows oversell | Repair | [Read](https://www.allanninal.dev/woocommerce/stale-reserved-stock-rows-oversell/) |
| [stripe-bills-after-cancellation](./stripe-bills-after-cancellation/) | Stripe bills after cancellation | Repair | [Read](https://www.allanninal.dev/woocommerce/stripe-bills-after-cancellation/) |
| [stripe-link-becomes-manual](./stripe-link-becomes-manual/) | Stripe Link becomes manual | Repair | [Read](https://www.allanninal.dev/woocommerce/stripe-link-becomes-manual/) |
| [stuck-in-pending-cancel](./stuck-in-pending-cancel/) | Stuck in pending-cancel | Reconciler | [Read](https://www.allanninal.dev/woocommerce/stuck-in-pending-cancel/) |
| [subscription-price-drifts-from-the-product](./subscription-price-drifts-from-the-product/) | Subscription price drifts from the product | Reconciler | [Read](https://www.allanninal.dev/woocommerce/subscription-price-drifts-from-the-product/) |
| [subscription-will-not-end](./subscription-will-not-end/) | Subscription will not end | Reconciler | [Read](https://www.allanninal.dev/woocommerce/subscription-will-not-end/) |
| [sync-products-to-stripe](./sync-products-to-stripe/) | Sync products to Stripe | Repair | [Read](https://www.allanninal.dev/woocommerce/sync-products-to-stripe/) |
| [timezone-corrupted-next-payment-dates](./timezone-corrupted-next-payment-dates/) | Timezone-corrupted next payment dates | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/timezone-corrupted-next-payment-dates/) |
| [trashed-orders-still-counted-in-stats](./trashed-orders-still-counted-in-stats/) | Trashed orders still counted in stats | Repair | [Read](https://www.allanninal.dev/woocommerce/trashed-orders-still-counted-in-stats/) |
| [trial-end-action-false-positive-failure](./trial-end-action-false-positive-failure/) | Trial end action false-positive failure | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/trial-end-action-false-positive-failure/) |
| [variations-stuck-on-backorder-at-zero](./variations-stuck-on-backorder-at-zero/) | Variations stuck On Backorder at zero | Repair | [Read](https://www.allanninal.dev/woocommerce/variations-stuck-on-backorder-at-zero/) |
| [webhook-api-version-mismatch](./webhook-api-version-mismatch/) | Webhook API version mismatch | Repair | [Read](https://www.allanninal.dev/woocommerce/webhook-api-version-mismatch/) |
| [wp-cron-disabled-emails-never-send](./wp-cron-disabled-emails-never-send/) | WP-Cron disabled, emails never send | Diagnostic | [Read](https://www.allanninal.dev/woocommerce/wp-cron-disabled-emails-never-send/) |
| [wrong-coupon-type-on-renewals](./wrong-coupon-type-on-renewals/) | Wrong coupon type on renewals | Repair | [Read](https://www.allanninal.dev/woocommerce/wrong-coupon-type-on-renewals/) |
| [zero-cost-renewal-orphaned-by-block-checkout](./zero-cost-renewal-orphaned-by-block-checkout/) | Zero cost renewal orphaned by block checkout | Repair | [Read](https://www.allanninal.dev/woocommerce/zero-cost-renewal-orphaned-by-block-checkout/) |
| [zero-decimal-currency-charged-100x](./zero-decimal-currency-charged-100x/) | Zero decimal currency charged 100x | Repair | [Read](https://www.allanninal.dev/woocommerce/zero-decimal-currency-charged-100x/) |

More fixes land as the guides are published. Watch or star the repo to follow along.

## Running the tests

The decision logic in every fix is a pure function with no network calls, so the tests run anywhere.

```bash
# Python
pip install pytest
pytest

# Node
node --test
```

## A note on safety

These scripts can change orders, subscriptions, and issue refunds. Always run with `DRY_RUN=true` first, read the output, and confirm it is correct before you let a script write. Test against a staging store when you can.

## Work with me

Fighting a WooCommerce, WooCommerce Subscriptions, or WooCommerce Stripe bug you would rather hand off? That is what I do.

- GitHub: [github.com/allanninal](https://github.com/allanninal)
- LinkedIn: [in/allanninal](https://www.linkedin.com/in/allanninal/)
- Support the work: [ko-fi.com/allanninal](https://ko-fi.com/allanninal)

## License

MIT. Use it, change it, ship it.
