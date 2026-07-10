from detect_rounding_drift import decide, intent_id_of, order_total_minor


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000}
    base.update(over)
    return base


def test_ok_when_amounts_match_exactly():
    order = {"status": "processing", "total": "50.00"}
    assert decide(order, intent())[0] == "ok"


def test_drift_when_off_by_one_cent():
    order = {"status": "processing", "total": "50.01"}
    assert decide(order, intent(amount_received=5000))[0] == "drift"


def test_drift_when_stripe_charged_one_cent_more():
    order = {"status": "completed", "total": "49.99"}
    assert decide(order, intent(amount_received=5000))[0] == "drift"


def test_mismatch_when_off_by_more_than_tolerance():
    order = {"status": "processing", "total": "50.10"}
    assert decide(order, intent(amount_received=5000))[0] == "mismatch"


def test_orphan_when_no_intent():
    order = {"status": "completed", "total": "50.00"}
    assert decide(order, None)[0] == "orphan"


def test_orphan_when_intent_not_succeeded():
    order = {"status": "processing", "total": "50.00"}
    assert decide(order, intent(status="requires_payment_method"))[0] == "orphan"


def test_skip_when_order_not_paid():
    order = {"status": "pending", "total": "50.00"}
    assert decide(order, None)[0] == "skip"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_order_total_minor_converts_to_cents():
    assert order_total_minor({"total": "50.01"}) == 5001
