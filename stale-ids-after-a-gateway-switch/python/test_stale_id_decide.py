from clear_stale_intent_ids import decide, intent_id_of


def test_clear_when_id_not_found_and_order_finished():
    order = {"status": "processing"}
    assert decide(order, "not_found")[0] == "clear"


def test_skip_when_id_resolves():
    order = {"status": "completed"}
    assert decide(order, "resolved")[0] == "skip"


def test_skip_when_no_id_saved():
    order = {"status": "processing"}
    assert decide(order, "no_id")[0] == "skip"


def test_skip_when_order_not_finished_even_if_stale():
    order = {"status": "pending"}
    assert decide(order, "not_found")[0] == "skip"


def test_skip_on_hold_order_with_resolved_id():
    order = {"status": "on-hold"}
    assert decide(order, "resolved")[0] == "skip"


def test_clear_on_refunded_order_with_stale_id():
    order = {"status": "refunded"}
    assert decide(order, "not_found")[0] == "clear"


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
