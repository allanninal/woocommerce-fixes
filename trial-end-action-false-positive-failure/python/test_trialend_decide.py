from clear_trial_end_false_positive import decide, intent_id_of, order_amount_minor


def sub(**over):
    base = {"status": "active", "trial_total_minor": 0}
    base.update(over)
    return base


def order(**over):
    base = {"status": "processing", "total": "50.00"}
    base.update(over)
    return base


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000}
    base.update(over)
    return base


def test_clear_when_active_no_renewal_needed_and_no_charge_due():
    assert decide(sub(status="active", trial_total_minor=0), None, None)[0] == "clear"


def test_unclear_when_active_no_renewal_but_trial_had_a_charge():
    assert decide(sub(status="active", trial_total_minor=500), None, None)[0] == "unclear"


def test_leave_when_still_on_trial():
    assert decide(sub(status="trial"), None, None)[0] == "leave"


def test_leave_when_renewal_order_failed():
    assert decide(sub(), order(status="failed"), None)[0] == "leave"


def test_unclear_when_no_intent_yet():
    assert decide(sub(), order(), None)[0] == "unclear"


def test_leave_when_intent_not_succeeded():
    assert decide(sub(), order(), intent(status="requires_payment_method"))[0] == "leave"


def test_unclear_when_amount_mismatch():
    assert decide(sub(), order(total="80.00"), intent())[0] == "unclear"


def test_clear_when_everything_checks_out():
    assert decide(sub(), order(), intent())[0] == "clear"


def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None


def test_order_amount_minor_converts_to_cents():
    assert order_amount_minor({"total": "19.99"}) == 1999
