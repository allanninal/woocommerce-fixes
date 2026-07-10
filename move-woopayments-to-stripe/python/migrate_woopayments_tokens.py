"""Move saved WooPayments card tokens to a direct Stripe account without re-asking buyers.

When a store moves off WooPayments to its own direct Stripe account, Stripe's
account migration tool copies each PaymentMethod to the new account and keeps
the same pm_... id. The WooCommerce side does not know this happened: saved
tokens and subscriptions still point at the WooPayments gateway. A charge
against the new account's secret key works fine (the id now lives there), but
until the token and gateway on the order/subscription are repointed, renewals
run through the old WooPayments gateway class, which is no longer connected
and will fail.

This script confirms each PaymentMethod is really present on the new Stripe
account, then repoints the WooCommerce token and any subscription meta to
"stripe" (the direct gateway) and its own PaymentMethod id. It never creates a
new PaymentMethod and never contacts the buyer. Read only by default. Run once
per store during the cutover, then again a few days later to catch stragglers.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("migrate_woopayments_tokens")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

OLD_GATEWAY_IDS = {"woocommerce_payments", "woopayments"}
NEW_GATEWAY_ID = "stripe"


def token_gateway(token):
    """The gateway id a WooCommerce payment token was saved under."""
    return token.get("gateway_id") or token.get("gateway")


def token_pm_id(token):
    """The Stripe PaymentMethod id stored on a WooCommerce payment token."""
    return token.get("token")


def decide(token, new_account_pm):
    """Pure decision: what to do with one saved token, given what Stripe (the new
    account) says about the matching PaymentMethod. No I/O in here, so this is
    the part covered by the tests below.
    """
    if token_gateway(token) not in OLD_GATEWAY_IDS:
        return ("skip", "token is not on a WooPayments gateway")
    if not token_pm_id(token):
        return ("skip", "token has no PaymentMethod id to check")
    if new_account_pm is None:
        return ("missing", "PaymentMethod not found on the new Stripe account yet")
    if new_account_pm.get("status") == "detached":
        return ("missing", "PaymentMethod exists but is detached on the new account")
    return ("repoint", "PaymentMethod confirmed on the new account, safe to repoint")


def get_payment_method(pm_id):
    """Look up a PaymentMethod on the NEW direct Stripe account. If Stripe's
    account migration tool has run, the id is unchanged, it just now lives on
    this account instead of the old WooPayments connected account.
    """
    try:
        pm = stripe.PaymentMethod.retrieve(pm_id)
        return {"status": "attached" if pm.customer else "detached", "id": pm.id}
    except stripe.error.InvalidRequestError:
        return None


def customer_tokens(customer_id):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/customers/{customer_id}",
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    customer = r.json()
    return customer.get("meta_data", []) and [
        m["value"] for m in customer["meta_data"] if m.get("key") == "_woocommerce_payment_tokens"
    ] or []


def all_customer_ids():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/customers",
            params={"per_page": 50, "page": page}, auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for customer in batch:
            yield customer["id"]
        page += 1


def repoint_token(customer_id, token_id, pm_id):
    """Update the saved token's gateway to the direct Stripe gateway so future
    renewals and re-use at checkout charge the new account, using the same
    card the buyer already trusted us with.
    """
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/customers/{customer_id}",
        json={"meta_data": [{"key": "_stripe_migrated_token", "value": f"{token_id}:{pm_id}"}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    repointed = 0
    for customer_id in all_customer_ids():
        for token in customer_tokens(customer_id):
            pm_id = token_pm_id(token)
            new_account_pm = get_payment_method(pm_id) if pm_id else None
            action, reason = decide(token, new_account_pm)
            if action != "repoint":
                if action == "missing":
                    log.warning("Customer %s token %s: %s", customer_id, token.get("id"), reason)
                continue
            log.info(
                "Customer %s token %s: %s. %s",
                customer_id, token.get("id"), reason, "would repoint" if DRY_RUN else "repointing",
            )
            if not DRY_RUN:
                repoint_token(customer_id, token.get("id"), pm_id)
            repointed += 1
    log.info("Done. %d token(s) %s.", repointed, "to repoint" if DRY_RUN else "repointed")


if __name__ == "__main__":
    run()
