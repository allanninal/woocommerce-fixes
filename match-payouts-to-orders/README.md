# Match payouts to orders

A bank deposit is never the sum of the order totals you see in WooCommerce. Stripe groups many charges, refunds, and fees into one payout, converts everything to minor units, and settles a few days after the charge, none of which WooCommerce shows you. This job reads one payout's balance transactions from Stripe, matches each charge to its WooCommerce order by the saved PaymentIntent id, and builds a line by line report where the payout total, the matched order net amounts, and Stripe's own totals all agree to the cent. Any line that cannot be matched, or any payout that does not tie out, is flagged for a person to look at. It is read only by default.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/match-payouts-to-orders/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export TIE_OUT_TOLERANCE_MINOR="1"   # cents of slack before flagging a payout
export DRY_RUN="true"                # true prints the report, false also writes a CSV and order notes
export PAYOUT_ID="po_1Nxxxxxxxxxxxxx"

python match-payouts-to-orders/python/build_payout_report.py
node   match-payouts-to-orders/node/build-payout-report.js
```

`lineFor` and `summarize` (`line_for` and `summarize` in Python) are pure functions: a line is matched only when the WooCommerce order total agrees with the payout's net amount for that charge, and a payout only "ties out" when every charge, fee, and refund line accounts for the full payout amount to the cent. Start with `DRY_RUN=true` to review the report before it writes a CSV file or adds order notes.

## Test

```bash
pytest match-payouts-to-orders/python
node --test match-payouts-to-orders/node
```
