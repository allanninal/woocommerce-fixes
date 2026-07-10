from datetime import datetime, timezone

from realign_next_payment import decide, expected_next_payment, intent_id_of, order_amount_minor


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000}
    base.update(over)
    return base


def subscription(**over):
    base = {
        "billing_interval": 1,
        "billing_period": "month",
        "meta_data": [{"key": "_schedule_next_payment", "value": "2026-07-15T00:00:00"}],
    }
    base.update(over)
    return base


def renewal_order(**over):
    base = {
        "total": "50.00",
        "date_paid_gmt": "2026-06-10T00:00:00",
        "date_created_gmt": "2026-06-10T00:00:00",
    }
    base.update(over)
    return base


def test_fix_when_next_payment_left_on_old_cadence():
    # Paid early on June 10. Correct next payment is July 10, but the
    # subscription still shows July 15, the old cadence, so it should fix.
    sub = subscription(meta_data=[{"key": "_schedule_next_payment", "value": "2026-07-15T00:00:00"}])
    order = renewal_order()
    assert decide(sub, order, intent())[0] == "fix"


def test_skip_when_next_payment_already_correct():
    sub = subscription(meta_data=[{"key": "_schedule_next_payment", "value": "2026-07-10T00:00:00"}])
    order = renewal_order()
    assert decide(sub, order, intent())[0] == "skip"


def test_skip_when_intent_not_succeeded():
    sub = subscription()
    order = renewal_order()
    assert decide(sub, order, intent(status="requires_payment_method"))[0] == "skip"


def test_hold_when_no_intent():
    sub = subscription()
    order = renewal_order()
    assert decide(sub, order, None)[0] == "hold"


def test_hold_when_amount_mismatch():
    sub = subscription()
    order = renewal_order(total="80.00")
    assert decide(sub, order, intent())[0] == "hold"


def test_hold_when_next_payment_missing():
    sub = subscription(meta_data=[])
    order = renewal_order()
    assert decide(sub, order, intent())[0] == "hold"


def test_hold_when_paid_date_missing():
    sub = subscription()
    order = renewal_order(date_paid_gmt=None, date_created_gmt=None)
    assert decide(sub, order, intent())[0] == "hold"


def test_expected_next_payment_adds_one_period():
    paid_at = datetime(2026, 6, 10, tzinfo=timezone.utc)
    result = expected_next_payment(paid_at, 1, "month")
    assert result == datetime(2026, 7, 10, tzinfo=timezone.utc)


def test_expected_next_payment_respects_interval():
    paid_at = datetime(2026, 6, 10, tzinfo=timezone.utc)
    result = expected_next_payment(paid_at, 2, "week")
    assert result == datetime(2026, 6, 24, tzinfo=timezone.utc)


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_order_amount_minor_converts_to_cents():
    assert order_amount_minor({"total": "19.99"}) == 1999
