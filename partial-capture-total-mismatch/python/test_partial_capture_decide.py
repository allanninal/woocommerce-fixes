from sync_partial_capture import decide, intent_id_of, order_total_minor, to_major_str


def intent(**over):
    base = {"id": "pi_1", "status": "succeeded", "amount_received": 5000, "amount_capturable": 0}
    base.update(over)
    return base


def order(**over):
    base = {"status": "processing", "total": "80.00"}
    base.update(over)
    return base


def test_fix_when_captured_less_than_order_total():
    action, reason = decide(order(total="80.00"), intent(amount_received=5000))
    assert action == "fix"
    assert "5000" in reason


def test_ok_when_captured_matches_order_total():
    action, _ = decide(order(total="50.00"), intent(amount_received=5000))
    assert action == "ok"


def test_ok_within_one_cent_tolerance():
    action, _ = decide(order(total="50.00"), intent(amount_received=4999))
    assert action == "ok"


def test_skip_when_order_not_paid():
    action, _ = decide(order(status="pending"), intent())
    assert action == "skip"


def test_skip_when_no_intent():
    action, _ = decide(order(), None)
    assert action == "skip"


def test_skip_when_intent_status_not_relevant():
    action, _ = decide(order(), intent(status="canceled"))
    assert action == "skip"


def test_skip_when_capture_still_in_progress():
    action, reason = decide(order(), intent(amount_capturable=1500))
    assert action == "skip"
    assert "in progress" in reason


def test_flag_when_order_total_lower_than_charge():
    action, reason = decide(order(total="40.00"), intent(amount_received=5000))
    assert action == "flag"
    assert "lower" in reason


def test_requires_capture_status_is_evaluated():
    # amount_received is 0 until captured, so this only makes sense combined with
    # amount_capturable, which decide() checks first.
    action, _ = decide(order(total="80.00"), intent(status="requires_capture", amount_received=0, amount_capturable=0))
    assert action == "fix"


def test_order_total_minor_converts_correctly():
    assert order_total_minor({"total": "19.99"}) == 1999


def test_to_major_str_round_trips():
    assert to_major_str(5000) == "50.00"
    assert to_major_str(1999) == "19.99"


def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None
