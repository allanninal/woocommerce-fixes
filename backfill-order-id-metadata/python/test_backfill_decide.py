from backfill_order_id_metadata import decide, intent_id_of


def intent(**over):
    base = {"id": "pi_1", "status": "succeeded", "metadata": {}}
    base.update(over)
    return base


def test_backfill_when_metadata_missing():
    order = {"id": 501, "status": "processing"}
    assert decide(order, intent())[0] == "backfill"


def test_skip_when_metadata_already_correct():
    order = {"id": 501, "status": "processing"}
    assert decide(order, intent(metadata={"order_id": "501"}))[0] == "skip"


def test_backfill_when_metadata_points_at_wrong_order():
    order = {"id": 501, "status": "processing"}
    assert decide(order, intent(metadata={"order_id": "999"}))[0] == "backfill"


def test_orphan_when_intent_missing():
    order = {"id": 501, "status": "processing"}
    assert decide(order, None)[0] == "orphan"


def test_skip_when_intent_not_paid():
    order = {"id": 501, "status": "processing"}
    assert decide(order, intent(status="requires_payment_method"))[0] == "skip"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_backfill_when_metadata_is_none():
    order = {"id": 501, "status": "completed"}
    assert decide(order, intent(metadata=None))[0] == "backfill"
