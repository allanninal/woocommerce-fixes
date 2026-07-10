from record_fees import intent_id_of, has_fee_recorded, fee_and_net


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_1"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_1"


def test_intent_id_falls_back_to_transaction_id():
    assert intent_id_of({"meta_data": [], "transaction_id": "pi_2"}) == "pi_2"


def test_intent_id_none_when_charge_id():
    assert intent_id_of({"meta_data": [], "transaction_id": "ch_3"}) is None


def test_has_fee_recorded_true():
    assert has_fee_recorded({"meta_data": [{"key": "_stripe_fee", "value": "1.20"}]}) is True


def test_has_fee_recorded_false():
    assert has_fee_recorded({"meta_data": [{"key": "_other", "value": "x"}]}) is False


def test_fee_and_net_converts_cents():
    bt = {"fee": 175, "net": 4825}
    assert fee_and_net(bt) == {"fee": 1.75, "net": 48.25}


def test_fee_and_net_none_when_missing_transaction():
    assert fee_and_net(None) is None


def test_fee_and_net_none_when_fields_absent():
    assert fee_and_net({"fee": 100}) is None
