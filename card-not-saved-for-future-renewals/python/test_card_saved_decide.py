from datetime import datetime, timedelta, timezone

from find_unsaved_renewal_cards import decide, intent_id_of, days_until


NOW = datetime(2026, 7, 10, tzinfo=timezone.utc)


def subscription(**over):
    base = {
        "id": 501,
        "status": "active",
        "payment_method": "stripe",
        "next_payment_date_gmt": (NOW + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S"),
    }
    base.update(over)
    return base


def order(**over):
    base = {"id": 900, "status": "processing", "meta_data": [
        {"key": "_stripe_intent_id", "value": "pi_1"}
    ]}
    base.update(over)
    return base


def intent(**over):
    base = {"status": "succeeded", "customer": "cus_1", "payment_method": "pm_1"}
    base.update(over)
    return base


def test_ok_when_reusable_card_attached():
    assert decide(subscription(), order(), intent(), NOW)[0] == "ok"


def test_flag_when_no_customer_on_intent():
    assert decide(subscription(), order(), intent(customer=None), NOW)[0] == "flag"


def test_flag_when_no_payment_method_on_intent():
    assert decide(subscription(), order(), intent(payment_method=None), NOW)[0] == "flag"


def test_skip_when_subscription_not_active():
    sub = subscription(status="cancelled")
    assert decide(sub, order(), intent(), NOW)[0] == "skip"


def test_skip_when_not_stripe_gateway():
    sub = subscription(payment_method="paypal")
    assert decide(sub, order(), intent(), NOW)[0] == "skip"


def test_skip_when_renewal_not_due_soon():
    sub = subscription(next_payment_date_gmt=(NOW + timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S"))
    assert decide(sub, order(), intent(), NOW)[0] == "skip"


def test_skip_when_no_parent_order():
    assert decide(subscription(), None, intent(), NOW)[0] == "skip"


def test_skip_when_no_intent_found():
    assert decide(subscription(), order(), None, NOW)[0] == "skip"


def test_skip_when_intent_not_succeeded():
    assert decide(subscription(), order(), intent(status="requires_payment_method"), NOW)[0] == "skip"


def test_intent_id_from_meta():
    o = order(meta_data=[{"key": "_stripe_intent_id", "value": "pi_123"}])
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = order(meta_data=[], transaction_id="pi_456")
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = order(meta_data=[], transaction_id="ch_789")
    assert intent_id_of(o) is None


def test_days_until_none_when_missing():
    assert days_until(None, NOW) is None


def test_days_until_positive_for_future_date():
    future = (NOW + timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:%S")
    assert round(days_until(future, NOW)) == 5
