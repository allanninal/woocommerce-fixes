from repair_transient_residue import decide, intent_id_of, order_amount_minor


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000, "id": "pi_1"}
    base.update(over)
    return base


def test_repair_when_succeeded_but_order_left_unpaid():
    order = {"status": "pending", "total": "50.00"}
    action, _ = decide(order, intent())
    assert action == "repair"


def test_skip_when_succeeded_and_already_processing():
    order = {"status": "processing", "total": "50.00"}
    action, _ = decide(order, intent())
    assert action == "skip"


def test_skip_when_amount_mismatch_needs_a_human():
    order = {"status": "pending", "total": "40.00"}
    action, _ = decide(order, intent())
    assert action == "skip"


def test_repair_when_canceled_but_order_left_processing():
    order = {"status": "processing", "total": "50.00"}
    action, _ = decide(order, intent(status="canceled"))
    assert action == "repair"


def test_skip_when_canceled_and_order_already_on_hold():
    order = {"status": "on-hold", "total": "50.00"}
    action, _ = decide(order, intent(status="canceled"))
    assert action == "skip"


def test_skip_when_intent_still_in_progress():
    order = {"status": "pending", "total": "50.00"}
    action, _ = decide(order, intent(status="requires_action"))
    assert action == "skip"


def test_orphan_when_no_intent_id():
    order = {"status": "processing", "total": "50.00"}
    action, _ = decide(order, None)
    assert action == "orphan"


def test_skip_when_order_status_is_not_tracked():
    order = {"status": "cancelled", "total": "50.00"}
    action, _ = decide(order, intent(status="canceled"))
    assert action == "skip"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_order_amount_minor_converts_dollars_to_cents():
    assert order_amount_minor({"total": "19.99"}) == 1999
