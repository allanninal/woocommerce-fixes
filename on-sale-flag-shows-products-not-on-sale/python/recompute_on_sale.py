"""Recompute the on sale flag for WooCommerce products from their real prices.

The on sale badge and strikethrough price come from a cached flag that only updates
when WooCommerce resaves the product, usually through the daily wc_scheduled_sales
cron. If that cron is missed, or prices are changed outside the normal save path (a
direct database edit or a bulk import), the flag goes stale. This walks the catalog,
recomputes whether each product should be on sale right now, and corrects the ones
that disagree. Safe to run again and again. Read only when DRY_RUN is true. Run on
a schedule.

Guide: https://www.allanninal.dev/woocommerce/on-sale-flag-shows-products-not-on-sale/
"""
import os
import logging
import requests
from datetime import datetime, timezone
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recompute_on_sale")

WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def to_minor(price_string):
    """Convert a decimal price string to integer cents. Empty or None means no price set."""
    if price_string in (None, ""):
        return None
    return round(float(price_string) * 100)


def within_sale_window(date_from, date_to, now):
    """True when now falls inside the sale date range. A missing bound means no limit on that side."""
    if date_from and now < datetime.fromisoformat(str(date_from)):
        return False
    if date_to and now > datetime.fromisoformat(str(date_to)):
        return False
    return True


def should_be_on_sale(product, now):
    """Pure: work out whether a product should currently be on sale from its own fields."""
    regular = to_minor(product.get("regular_price"))
    sale = to_minor(product.get("sale_price"))
    if regular is None or sale is None:
        return False
    if sale >= regular:
        return False
    return within_sale_window(product.get("date_on_sale_from"), product.get("date_on_sale_to"), now)


def decide(product, now):
    """Pure decision function. No I/O. Returns (action, reason)."""
    expected = should_be_on_sale(product, now)
    actual = bool(product.get("on_sale"))
    if expected == actual:
        return ("skip", "on sale flag already matches the prices")
    if expected and not actual:
        return ("fix", "product should be on sale but the flag says no")
    # actual on_sale is stuck true: past the sale window, or the sale price is no
    # longer below the regular price, but the cached flag was never recalculated.
    return ("fix", "sale price is stale and should be cleared")


def all_products():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products",
            params={"per_page": 50, "page": page, "status": "publish"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for product in batch:
            yield product
        page += 1


def apply_fix(product_id, expected_on_sale, current_sale_price):
    """Nudge WooCommerce to recompute _price and the lookup table by resaving the
    sale price: keep it as-is when the product should be on sale, or clear it when
    the sale is over. We never invent a new price.
    """
    payload = {"sale_price": current_sale_price} if expected_on_sale else {"sale_price": ""}
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}",
        json=payload, auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    fixed = 0
    for product in all_products():
        action, reason = decide(product, now)
        if action == "skip":
            continue
        expected = should_be_on_sale(product, now)
        log.info(
            "Product %s: %s. %s",
            product["id"], reason, "would fix" if DRY_RUN else "fixing",
        )
        if not DRY_RUN:
            apply_fix(product["id"], expected, product.get("sale_price"))
        fixed += 1
    log.info("Done. %d product(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
