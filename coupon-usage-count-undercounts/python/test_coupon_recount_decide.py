from recount_coupon_usage import decide, order_counts_as_used, intent_id_of


def intent(**over):
    base = {"status": "succeeded"}
    base.update(over)
    return base


def test_ok_when_stored_matches_real():
    coupon = {"usage_count": 3}
    assert decide(coupon, 3)[0] == "ok"


def test_correct_when_stored_undercounts():
    coupon = {"usage_count": 2}
    action, reason = decide(coupon, 5)
    assert action == "correct"
    assert "undercounted" in reason


def test_correct_when_stored_overcounts():
    coupon = {"usage_count": 7}
    action, reason = decide(coupon, 4)
    assert action == "correct"
    assert "overcounted" in reason


def test_order_counts_when_processing_and_succeeded():
    order = {"status": "processing"}
    assert order_counts_as_used(order, intent()) is True


def test_order_does_not_count_when_cancelled():
    order = {"status": "cancelled"}
    assert order_counts_as_used(order, intent()) is False


def test_order_does_not_count_when_no_intent():
    order = {"status": "completed"}
    assert order_counts_as_used(order, None) is False


def test_order_does_not_count_when_intent_not_succeeded():
    order = {"status": "completed"}
    assert order_counts_as_used(order, intent(status="requires_payment_method")) is False


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
