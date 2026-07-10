from subscription_price_drift import decide, intent_id_of, line_item_total_minor, is_drift


def subscription(**over):
    base = {"id": 501, "status": "active", "total": "50.00"}
    base.update(over)
    return base


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000}
    base.update(over)
    return base


def order(**over):
    base = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_1"}], "transaction_id": ""}
    base.update(over)
    return base


def test_ok_when_total_matches_last_charge():
    action, _ = decide(subscription(), order(), intent())
    assert action == "ok"
    assert not is_drift(action)


def test_drift_when_subscription_total_is_higher():
    action, _ = decide(subscription(total="65.00"), order(), intent())
    assert action == "drift_under_charged"
    assert is_drift(action)


def test_drift_when_subscription_total_is_lower():
    action, _ = decide(subscription(total="35.00"), order(), intent())
    assert action == "drift_over_charged"
    assert is_drift(action)


def test_within_tolerance_is_ok():
    # amount_received 5000 cents vs total 50.01 -> 1 cent off, within default tolerance.
    action, _ = decide(subscription(total="50.01"), order(), intent())
    assert action == "ok"


def test_skip_when_subscription_not_active():
    action, reason = decide(subscription(status="cancelled"), order(), intent())
    assert action == "skip"
    assert "not active" in reason


def test_skip_when_no_last_order():
    action, reason = decide(subscription(), None, None)
    assert action == "skip"
    assert "no billed order" in reason


def test_skip_when_intent_missing():
    action, reason = decide(subscription(), order(), None)
    assert action == "skip"
    assert "no matching" in reason


def test_skip_when_intent_not_succeeded():
    action, reason = decide(subscription(), order(), intent(status="requires_payment_method"))
    assert action == "skip"
    assert "did not succeed" in reason


def test_intent_id_from_meta():
    o = order(meta_data=[{"key": "_stripe_intent_id", "value": "pi_123"}], transaction_id="")
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = order(meta_data=[], transaction_id="pi_456")
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = order(meta_data=[], transaction_id="ch_789")
    assert intent_id_of(o) is None


def test_line_item_total_minor_converts_dollars_to_cents():
    assert line_item_total_minor(subscription(total="12.34")) == 1234
