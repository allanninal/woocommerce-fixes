from check_amount_mismatch import decide, intent_id_of, order_amount_minor, captured_amount_minor


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000}
    base.update(over)
    return base


def test_ok_when_amounts_match():
    order = {"status": "processing", "total": "50.00"}
    assert decide(order, intent())[0] == "ok"


def test_flag_when_order_total_higher():
    order = {"status": "processing", "total": "55.00"}
    action, reason = decide(order, intent())
    assert action == "flag"
    assert "higher" in reason


def test_flag_when_order_total_lower():
    order = {"status": "completed", "total": "45.00"}
    action, reason = decide(order, intent())
    assert action == "flag"
    assert "lower" in reason


def test_skip_when_order_not_paid():
    order = {"status": "pending", "total": "50.00"}
    assert decide(order, intent())[0] == "skip"


def test_skip_when_no_intent():
    order = {"status": "processing", "total": "50.00"}
    assert decide(order, None)[0] == "skip"


def test_skip_when_intent_not_succeeded():
    order = {"status": "processing", "total": "50.00"}
    assert decide(order, intent(status="requires_payment_method"))[0] == "skip"


def test_tolerance_allows_rounding_of_one_cent():
    order = {"status": "processing", "total": "50.01"}
    assert decide(order, intent(amount_received=5000))[0] == "ok"


def test_custom_tolerance_can_be_stricter():
    order = {"status": "processing", "total": "50.01"}
    assert decide(order, intent(amount_received=5000), tolerance_minor=0)[0] == "flag"


def test_order_amount_minor_converts_dollars_to_cents():
    assert order_amount_minor({"total": "19.99"}) == 1999


def test_captured_amount_minor_prefers_amount_received():
    assert captured_amount_minor({"amount_received": 1200, "amount": 1500}) == 1200


def test_captured_amount_minor_falls_back_to_amount():
    assert captured_amount_minor({"amount": 1500}) == 1500


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
