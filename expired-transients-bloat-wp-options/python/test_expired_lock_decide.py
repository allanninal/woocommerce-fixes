from clear_stale_checkout_locks import decide, intent_id_of, lock_value_of, transient_key_for


def intent(**over):
    base = {"status": "succeeded", "id": "pi_1"}
    base.update(over)
    return base


def test_clear_when_lock_present_and_intent_settled():
    order = {"meta_data": [{"key": "_stripe_checkout_lock", "value": "1"}]}
    assert decide(order, intent())[0] == "clear"


def test_clear_when_intent_canceled():
    order = {"meta_data": [{"key": "_stripe_checkout_lock", "value": "1"}]}
    assert decide(order, intent(status="canceled"))[0] == "clear"


def test_skip_when_no_lock():
    order = {"meta_data": []}
    assert decide(order, intent())[0] == "skip"


def test_skip_when_no_intent():
    order = {"meta_data": [{"key": "_stripe_checkout_lock", "value": "1"}]}
    assert decide(order, None)[0] == "skip"


def test_skip_when_intent_still_in_progress():
    order = {"meta_data": [{"key": "_stripe_checkout_lock", "value": "1"}]}
    assert decide(order, intent(status="requires_action"))[0] == "skip"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_lock_value_of_present():
    order = {"meta_data": [{"key": "_stripe_checkout_lock", "value": "1"}]}
    assert lock_value_of(order) == "1"


def test_lock_value_of_missing():
    assert lock_value_of({"meta_data": []}) is None


def test_transient_key_for():
    assert transient_key_for("pi_123") == "_transient_wc_stripe_lock_pi_123"
