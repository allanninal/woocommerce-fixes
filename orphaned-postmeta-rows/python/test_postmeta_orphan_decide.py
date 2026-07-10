from find_orphaned_postmeta import decide, intent_id_of


def intent(**over):
    base = {"id": "pi_1", "metadata": {"order_id": "501"}}
    base.update(over)
    return base


def test_orphan_when_order_missing():
    assert decide(None, intent())[0] == "orphan"


def test_ok_when_order_still_exists():
    order = {"id": 501}
    assert decide(order, intent())[0] == "ok"


def test_skip_when_no_intent():
    assert decide({"id": 501}, None)[0] == "skip"


def test_skip_when_intent_has_no_order_id():
    assert decide(None, intent(metadata={}))[0] == "skip"


def test_skip_when_order_id_mismatch():
    order = {"id": 999}
    assert decide(order, intent())[0] == "skip"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
