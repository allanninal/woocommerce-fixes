from resolve_charge_id import decide, charge_id_of, intent_id_of, order_amount_minor


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000, "latest_charge": "ch_new_1"}
    base.update(over)
    return base


def order(**over):
    base = {
        "status": "pending",
        "total": "50.00",
        "transaction_id": "",
        "meta_data": [{"key": "_stripe_intent_id", "value": "pi_1"}],
    }
    base.update(over)
    return base


def test_charge_id_prefers_latest_charge_string():
    assert charge_id_of({"latest_charge": "ch_new_1", "charges": {"data": [{"id": "ch_old_1"}]}}) == "ch_new_1"


def test_charge_id_falls_back_to_legacy_charges_list():
    assert charge_id_of({"latest_charge": None, "charges": {"data": [{"id": "ch_old_1"}]}}) == "ch_old_1"


def test_charge_id_handles_expanded_latest_charge_object():
    assert charge_id_of({"latest_charge": {"id": "ch_expanded_1"}}) == "ch_expanded_1"


def test_charge_id_none_when_neither_shape_present():
    assert charge_id_of({"latest_charge": None, "charges": {"data": []}}) is None


def test_repair_when_new_shape_only_and_no_transaction_id():
    assert decide(order(), intent())[0] == "repair"


def test_repair_when_only_legacy_charges_shape_present():
    old_shape_intent = intent(latest_charge=None, charges={"data": [{"id": "ch_old_1"}]})
    assert decide(order(), old_shape_intent)[0] == "repair"


def test_skip_when_no_saved_intent_id():
    assert decide(order(meta_data=[], transaction_id=""), intent())[0] == "skip"


def test_skip_when_order_already_has_transaction_id():
    assert decide(order(transaction_id="ch_already_set"), intent())[0] == "skip"


def test_skip_when_intent_not_succeeded():
    assert decide(order(), intent(status="requires_payment_method"))[0] == "skip"


def test_orphan_when_succeeded_but_no_charge_id_on_either_shape():
    assert decide(order(), intent(latest_charge=None, charges={"data": []}))[0] == "orphan"


def test_mismatch_when_amount_differs():
    assert decide(order(total="80.00"), intent())[0] == "mismatch"


def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_already_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None


def test_order_amount_minor_converts_to_cents():
    assert order_amount_minor({"total": "19.99"}) == 1999
