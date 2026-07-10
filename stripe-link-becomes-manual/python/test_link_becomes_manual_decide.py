from restore_automatic_renewal import decide, is_reusable, intent_id_of


def pm(**over):
    base = {"type": "card"}
    base.update(over)
    return base


def test_repair_when_manual_and_reusable_method_found():
    sub = {"requires_manual_renewal": True, "payment_method": "stripe"}
    assert decide(sub, pm())[0] == "repair"


def test_repair_allows_bank_account_and_sepa_too():
    sub = {"requires_manual_renewal": True, "payment_method": "stripe"}
    assert decide(sub, pm(type="us_bank_account"))[0] == "repair"
    assert decide(sub, pm(type="sepa_debit"))[0] == "repair"


def test_skip_when_already_automatic():
    sub = {"requires_manual_renewal": False, "payment_method": "stripe"}
    assert decide(sub, pm())[0] == "skip"


def test_skip_when_not_stripe_gateway():
    sub = {"requires_manual_renewal": True, "payment_method": "cheque"}
    assert decide(sub, pm())[0] == "skip"


def test_keep_manual_when_no_payment_method():
    sub = {"requires_manual_renewal": True, "payment_method": "stripe"}
    assert decide(sub, None)[0] == "keep_manual"


def test_keep_manual_when_payment_method_is_not_reusable_type():
    sub = {"requires_manual_renewal": True, "payment_method": "stripe"}
    assert decide(sub, pm(type="link"))[0] == "keep_manual"


def test_is_reusable_false_for_none():
    assert is_reusable(None) is False


def test_is_reusable_true_for_card():
    assert is_reusable(pm(type="card")) is True


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
