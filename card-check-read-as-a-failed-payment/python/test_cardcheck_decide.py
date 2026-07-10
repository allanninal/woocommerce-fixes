from card_check_auditor import decide, intent_id_of


def intent(**over):
    base = {"id": "pi_1", "amount": 0, "status": "requires_payment_method"}
    base.update(over)
    return base


def test_restore_when_intent_amount_is_zero():
    sub = {"status": "on-hold"}
    assert decide(sub, intent())[0] == "restore"


def test_skip_when_subscription_not_dunned():
    sub = {"status": "active"}
    assert decide(sub, intent())[0] == "skip"


def test_skip_when_no_intent_to_check():
    sub = {"status": "on-hold"}
    assert decide(sub, None)[0] == "skip"


def test_skip_when_real_charge_declined():
    sub = {"status": "on-hold"}
    assert decide(sub, intent(amount=2900, status="requires_payment_method"))[0] == "skip"


def test_skip_when_intent_actually_succeeded():
    sub = {"status": "pending-cancel"}
    assert decide(sub, intent(amount=2900, status="succeeded"))[0] == "skip"


def test_restore_applies_to_pending_cancel_too():
    sub = {"status": "pending-cancel"}
    assert decide(sub, intent())[0] == "restore"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
