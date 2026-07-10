from repair_sepa_renewal import decide, intent_id_of


def intent(**over):
    base = {"status": "requires_payment_method", "id": "pi_1"}
    base.update(over)
    return base


def test_repair_when_mandate_failed_on_paid_order():
    order = {"status": "processing"}
    assert decide(order, intent())[0] == "repair"


def test_repair_when_mandate_canceled():
    order = {"status": "completed"}
    assert decide(order, intent(status="canceled"))[0] == "repair"


def test_wait_when_still_processing():
    order = {"status": "processing"}
    assert decide(order, intent(status="processing"))[0] == "wait"


def test_skip_when_succeeded():
    order = {"status": "processing"}
    assert decide(order, intent(status="succeeded"))[0] == "skip"


def test_skip_when_already_on_hold():
    order = {"status": "on-hold"}
    assert decide(order, intent())[0] == "skip"


def test_skip_when_already_failed():
    order = {"status": "failed"}
    assert decide(order, intent())[0] == "skip"


def test_skip_when_order_not_paid():
    order = {"status": "pending"}
    assert decide(order, intent())[0] == "skip"


def test_skip_when_no_intent():
    order = {"status": "processing"}
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
