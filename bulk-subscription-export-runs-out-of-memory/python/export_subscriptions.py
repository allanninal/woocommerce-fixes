"""Export every WooCommerce Subscription to CSV without loading them all into memory.

A "export all subscriptions" job that calls the REST API once with a huge
per_page, or that appends every page into one Python list before writing the
file, grows without bound as the store grows. On a store with tens of
thousands of subscriptions this is what runs out of memory and gets killed
partway through, usually with a half written, unusable CSV file.

This script fetches one page at a time, writes each row to disk as soon as
it arrives, and never keeps more than one page of subscriptions in memory.
A pure planner function decides the next step (keep paging, shrink the page
size, or stop) from plain numbers, so the paging logic can be unit tested
with no network and no real file.

Read only against WooCommerce. Safe to run again and again. Run on a
schedule or by hand whenever you need a fresh export.
"""
import csv
import os
import logging

import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("export_subscriptions")

WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
EXPORT_PATH = os.environ.get("EXPORT_PATH", "subscriptions_export.csv")
START_PAGE_SIZE = int(os.environ.get("START_PAGE_SIZE", "100"))
MIN_PAGE_SIZE = int(os.environ.get("MIN_PAGE_SIZE", "10"))
MEMORY_BUDGET_MB = int(os.environ.get("MEMORY_BUDGET_MB", "150"))
MAX_ROWS = int(os.environ.get("MAX_ROWS", "0")) or None  # 0 means no cap
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

FIELDS = ["id", "status", "total", "billing_period", "billing_interval", "next_payment_date", "customer_id"]


def bytes_per_row_estimate(page_bytes, row_count):
    """Average bytes per subscription in a page. Zero rows means no data to size from."""
    if row_count <= 0:
        return 0
    return page_bytes / row_count


def plan_next_page(state):
    """Pure planner. Decides the next paging action from plain numbers only.

    state keys:
      page_size            current rows requested per page
      rows_in_last_page    rows actually returned by the last request (0 if none yet)
      last_page_bytes      approximate size in bytes of the last page's JSON
      total_rows_so_far    rows written to the CSV so far
      max_rows             cap on total rows to export, or None for no cap
      memory_budget_mb     the memory ceiling we plan against, in megabytes

    Returns one of:
      ("stop_done", reason)     no more pages, or the row cap was reached
      ("shrink", reason)        a page was too heavy for the budget, halve the size and retry
      ("continue", reason)      request the next page at the current page_size
    """
    page_size = state["page_size"]
    rows_in_last_page = state["rows_in_last_page"]
    last_page_bytes = state["last_page_bytes"]
    total_rows_so_far = state["total_rows_so_far"]
    max_rows = state.get("max_rows")
    memory_budget_mb = state["memory_budget_mb"]

    if max_rows is not None and total_rows_so_far >= max_rows:
        return ("stop_done", "row cap reached")

    if rows_in_last_page == 0 and state.get("has_fetched_a_page"):
        return ("stop_done", "no more subscriptions")

    budget_bytes = memory_budget_mb * 1024 * 1024
    # A page is only ever held in memory once, briefly, right after the request
    # returns and before it is written and discarded. If that one page alone
    # would already blow the budget, shrink the page size and try again rather
    # than ever holding a bigger page.
    if last_page_bytes > budget_bytes and page_size > MIN_PAGE_SIZE:
        return ("shrink", "last page was too heavy for the memory budget")

    return ("continue", "keep paging at the current size")


def next_page_size(current_page_size):
    """Halve the page size on a shrink, but never below MIN_PAGE_SIZE."""
    return max(MIN_PAGE_SIZE, current_page_size // 2)


def to_row(sub):
    """Flatten one subscription REST object to the CSV row we export."""
    return {field: sub.get(field, "") for field in FIELDS}


def fetch_page(page, page_size):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions",
        params={"per_page": page_size, "page": page, "orderby": "id", "order": "asc"},
        auth=AUTH,
        timeout=60,
    )
    r.raise_for_status()
    return r.content, r.json()


def run():
    if DRY_RUN:
        log.info("DRY_RUN is true. Counting subscriptions and planning pages, not writing %s.", EXPORT_PATH)

    page = 1
    page_size = START_PAGE_SIZE
    total_rows_so_far = 0
    state = {
        "page_size": page_size,
        "rows_in_last_page": 0,
        "last_page_bytes": 0,
        "total_rows_so_far": 0,
        "max_rows": MAX_ROWS,
        "memory_budget_mb": MEMORY_BUDGET_MB,
        "has_fetched_a_page": False,
    }

    writer = None
    fh = None
    if not DRY_RUN:
        fh = open(EXPORT_PATH, "w", newline="", encoding="utf-8")
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()

    try:
        while True:
            action, reason = plan_next_page(state)
            if action == "stop_done":
                log.info("Stopping: %s.", reason)
                break
            if action == "shrink":
                page_size = next_page_size(page_size)
                log.warning("Shrinking page size to %d: %s.", page_size, reason)
                state["page_size"] = page_size
                # Retry the same page number at the smaller size, do not advance.
                state["last_page_bytes"] = 0
                continue

            raw_bytes, rows = fetch_page(page, page_size)
            row_count = len(rows)

            if not DRY_RUN:
                for sub in rows:
                    writer.writerow(to_row(sub))
                fh.flush()  # push each page to disk, never buffer pages in memory
            total_rows_so_far += row_count

            log.info(
                "Page %d: %d subscription(s) at page size %d (%d bytes).",
                page, row_count, page_size, len(raw_bytes),
            )

            state.update({
                "page_size": page_size,
                "rows_in_last_page": row_count,
                "last_page_bytes": len(raw_bytes),
                "total_rows_so_far": total_rows_so_far,
                "has_fetched_a_page": True,
            })
            page += 1
    finally:
        if fh:
            fh.close()

    log.info("Done. %d subscription row(s) %s.", total_rows_so_far, "counted" if DRY_RUN else f"written to {EXPORT_PATH}")


if __name__ == "__main__":
    run()
