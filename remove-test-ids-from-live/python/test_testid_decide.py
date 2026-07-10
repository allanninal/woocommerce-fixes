from remove_test_ids import decide, intent_id_of


def test_clear_when_id_missing_on_live():
    order = {"status": "processing"}
    assert decide(order, "pi_test_123", None)[0] == "clear"


def test_ok_when_id_resolves():
    order = {"status": "processing"}
    assert decide(order, "pi_live_123", {"id": "pi_live_123"})[0] == "ok"


def test_skip_when_no_id_saved():
    order = {"status": "processing"}
    assert decide(order, None, None)[0] == "skip"


def test_skip_when_order_not_in_paid_state():
    order = {"status": "pending"}
    assert decide(order, "pi_test_123", None)[0] == "skip"


def test_clear_when_on_hold_and_missing():
    order = {"status": "on-hold"}
    assert decide(order, "pi_test_999", None)[0] == "clear"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_intent_id_none_when_nothing_saved():
    order = {"meta_data": [], "transaction_id": ""}
    assert intent_id_of(order) is None
