"""Check whether the Stripe webhook that WooCommerce depends on is set up right.
Read only. It reports problems, it does not change anything.

Guide: https://www.allanninal.dev/woocommerce/stripe-webhook-not-delivered-configuration/
"""
import os
from urllib.parse import urlparse
import stripe

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
STORE_HOST = urlparse(os.environ["WOO_STORE_URL"]).netloc

REQUIRED = {"payment_intent.succeeded", "payment_intent.payment_failed",
            "charge.succeeded", "charge.refunded"}


def endpoint_health(endpoint, store_host):
    events = set(endpoint.get("enabled_events", []))
    covers = "*" in events or REQUIRED.issubset(events)
    host_ok = urlparse(endpoint.get("url", "")).netloc == store_host
    return {
        "id": endpoint["id"],
        "url": endpoint.get("url", ""),
        "enabled": endpoint["status"] == "enabled",
        "points_at_store": host_ok,
        "covers_events": covers,
        "missing_events": sorted(REQUIRED - events) if not covers else [],
    }


def check_endpoints(store_host):
    return [endpoint_health(e, store_host)
            for e in stripe.WebhookEndpoint.list(limit=100).auto_paging_iter()]


def undelivered_recent(limit=100):
    pending = total = 0
    for event in stripe.Event.list(limit=limit).auto_paging_iter():
        total += 1
        if event.get("pending_webhooks", 0) > 0:
            pending += 1
    return {"checked": total, "still_pending": pending}


def run():
    reports = check_endpoints(STORE_HOST)
    healthy = [r for r in reports if r["enabled"] and r["points_at_store"] and r["covers_events"]]
    print(f"Found {len(reports)} endpoint(s). {len(healthy)} healthy for this store.")
    for r in reports:
        flags = []
        if not r["enabled"]:
            flags.append("disabled")
        if not r["points_at_store"]:
            flags.append("wrong domain")
        if not r["covers_events"]:
            flags.append("missing events: " + ", ".join(r["missing_events"]))
        status = "OK" if not flags else "PROBLEM: " + "; ".join(flags)
        print(f"  {r['id']}  {r['url']}  ->  {status}")
    if not healthy:
        print("No healthy endpoint points at this store. That is why orders do not update.")
    delivery = undelivered_recent()
    print(f"Recent events checked: {delivery['checked']}, still pending delivery: {delivery['still_pending']}")
    if delivery["still_pending"]:
        print("Events are not being accepted by your endpoint. Check for a firewall, CDN, or a server error.")


if __name__ == "__main__":
    run()
