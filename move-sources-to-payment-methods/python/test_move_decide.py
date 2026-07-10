from migrate_sources_to_pm import decide, is_legacy_source, is_already_payment_method, token_of


def order(**over):
    base = {"id": 701, "status": "pending"}
    base.update(over)
    return base


def source(**over):
    base = {"type": "card", "status": "chargeable"}
    base.update(over)
    return base


def test_migrate_when_legacy_card_source_is_chargeable():
    assert decide(order(), "src_1AbCdEfGhIjKlMnO", source())[0] == "migrate"


def test_migrate_when_legacy_card_source_is_consumed():
    assert decide(order(), "src_1AbCdEfGhIjKlMnO", source(status="consumed"))[0] == "migrate"


def test_flag_when_source_missing_from_stripe():
    assert decide(order(), "src_1AbCdEfGhIjKlMnO", None)[0] == "flag"


def test_flag_when_source_not_a_card():
    assert decide(order(), "src_1AbCdEfGhIjKlMnO", source(type="sepa_debit"))[0] == "flag"


def test_flag_when_source_no_longer_chargeable():
    assert decide(order(), "src_1AbCdEfGhIjKlMnO", source(status="failed"))[0] == "flag"


def test_skip_when_already_a_payment_method():
    assert decide(order(), "pm_1XyZ", None)[0] == "skip"


def test_skip_when_no_token_saved():
    assert decide(order(), None, None)[0] == "skip"


def test_skip_when_order_status_not_tracked():
    assert decide(order(status="cancelled"), "src_1AbCdEfGhIjKlMnO", source())[0] == "skip"


def test_is_legacy_source_true_for_src_prefix():
    assert is_legacy_source("src_1AbCdEfGhIjKlMnO") is True


def test_is_legacy_source_false_for_payment_method():
    assert is_legacy_source("pm_1XyZ") is False


def test_is_legacy_source_false_for_none():
    assert is_legacy_source(None) is False


def test_is_already_payment_method_true_for_pm_prefix():
    assert is_already_payment_method("pm_1XyZ") is True


def test_is_already_payment_method_false_for_source():
    assert is_already_payment_method("src_1AbCdEfGhIjKlMnO") is False


def test_token_of_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "src_123"}], "transaction_id": ""}
    assert token_of(o) == "src_123"


def test_token_of_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "src_456"}
    assert token_of(o) == "src_456"


def test_token_of_none_when_nothing_saved():
    o = {"meta_data": [], "transaction_id": ""}
    assert token_of(o) is None
