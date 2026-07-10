from audit_stuck_actions import decide, intent_id_of


def action(**over):
    base = {"status": "in-progress", "age_minutes": 55, "action_id": 1}
    base.update(over)
    return base


def order(**over):
    base = {"status": "pending", "total": "50.00"}
    base.update(over)
    return base


def intent(**over):
    base = {"status": "succeeded", "id": "pi_1"}
    base.update(over)
    return base


def test_skip_when_action_not_in_progress():
    assert decide(action(status="complete"), order(), intent())[0] == "skip"


def test_wait_when_not_stuck_long_enough():
    assert decide(action(age_minutes=5), order(), intent())[0] == "wait"


def test_investigate_when_order_missing():
    assert decide(action(), None, None)[0] == "investigate"


def test_investigate_when_payment_in_flight():
    assert decide(action(), order(), intent(status="requires_action"))[0] == "investigate"


def test_reset_when_order_already_paid():
    assert decide(action(), order(status="processing"), intent())[0] == "reset_action"


def test_complete_order_when_stripe_succeeded_but_order_unpaid():
    verdict, _ = decide(action(), order(status="pending"), intent(status="succeeded"))
    assert verdict == "complete_order"


def test_reset_when_no_intent_at_all():
    assert decide(action(), order(), None)[0] == "reset_action"


def test_reset_when_intent_failed():
    assert decide(action(), order(), intent(status="requires_payment_method"))[0] == "reset_action"


def test_reset_when_intent_canceled():
    assert decide(action(), order(), intent(status="canceled"))[0] == "reset_action"


def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None
