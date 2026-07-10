from exclude_trashed_from_stats import decide, intent_id_of, is_excluded


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000, "amount_refunded": 0}
    base.update(over)
    return base


def test_skip_when_not_trashed():
    order = {"status": "processing"}
    assert decide(order, intent())[0] == "skip"


def test_skip_when_already_excluded():
    order = {"status": "trash", "meta_data": [{"key": "_exclude_from_stats", "value": "yes"}]}
    assert decide(order, intent())[0] == "skip"


def test_repair_when_no_intent():
    order = {"status": "trash", "meta_data": []}
    assert decide(order, None)[0] == "repair"


def test_repair_when_intent_not_succeeded():
    order = {"status": "trash", "meta_data": []}
    assert decide(order, intent(status="requires_payment_method"))[0] == "repair"


def test_repair_when_fully_refunded():
    order = {"status": "trash", "meta_data": []}
    assert decide(order, intent(amount_refunded=5000))[0] == "repair"


def test_hold_when_charge_is_live_and_unrefunded():
    order = {"status": "trash", "meta_data": []}
    assert decide(order, intent())[0] == "hold"


def test_is_excluded_true_variants():
    assert is_excluded({"meta_data": [{"key": "_exclude_from_stats", "value": "1"}]}) is True
    assert is_excluded({"meta_data": [{"key": "_exclude_from_stats", "value": "yes"}]}) is True


def test_is_excluded_false_when_absent():
    assert is_excluded({"meta_data": []}) is False


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
