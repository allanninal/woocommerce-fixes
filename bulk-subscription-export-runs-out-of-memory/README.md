# Bulk subscription export runs out of memory

A full subscription export that asks the REST API for every row in one request, or that appends every page into one array before writing the CSV, grows without bound as the store grows. On a store with tens of thousands of subscriptions this is what runs out of memory and gets killed partway through, usually leaving a half written, unusable file. This script fetches one page at a time, writes each row to disk as soon as it arrives, and never keeps more than one page in memory. A pure planner function decides whether to keep paging, shrink the page size, or stop, so the paging logic can be unit tested with no network and no real file.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/bulk-subscription-export-runs-out-of-memory/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export EXPORT_PATH="subscriptions_export.csv"
export START_PAGE_SIZE="100"
export MIN_PAGE_SIZE="10"
export MEMORY_BUDGET_MB="150"
export DRY_RUN="true"   # true only counts and plans, does not write the file

python bulk-subscription-export-runs-out-of-memory/python/export_subscriptions.py
node   bulk-subscription-export-runs-out-of-memory/node/export-subscriptions.js
```

`plan_next_page` / `planNextPage` is a pure function: it decides to keep paging, shrink the page size, or stop, from plain numbers only, no HTTP calls and no file writes. Start with `DRY_RUN=true` to see how many pages the export will take before it writes anything.

## Test

```bash
pytest bulk-subscription-export-runs-out-of-memory/python
node --test bulk-subscription-export-runs-out-of-memory/node
```
