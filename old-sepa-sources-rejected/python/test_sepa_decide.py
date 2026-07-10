from migrate_sepa_sources import decide, is_legacy_source, token_of


def order(**over):
    base = {"id": 501, "status": "pending"}
    base.update(over)
    return base


def test_migrate_when_legacy_source_and_replacement_exists():
    assert decide(order(), "src_1AbCdEfGhIjKlMnO", "pm_1XyZ")[0] == "migrate"


def test_flag_when_legacy_source_and_no_replacement():
    assert decide(order(), "src_1AbCdEfGhIjKlMnO", None)[0] == "flag"


def test_skip_when_token_is_not_a_legacy_source():
    assert decide(order(), "pm_1XyZ", None)[0] == "skip"


def test_skip_when_token_missing():
    assert decide(order(), None, None)[0] == "skip"


def test_skip_when_order_not_in_renewal_status():
    assert decide(order(status="completed"), "src_1AbCdEfGhIjKlMnO", "pm_1XyZ")[0] == "skip"


def test_is_legacy_source_true_for_src_prefix():
    assert is_legacy_source("src_1AbCdEfGhIjKlMnO") is True


def test_is_legacy_source_false_for_payment_method():
    assert is_legacy_source("pm_1XyZ") is False


def test_is_legacy_source_false_for_none():
    assert is_legacy_source(None) is False


def test_token_of_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "src_123"}], "transaction_id": ""}
    assert token_of(o) == "src_123"


def test_token_of_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "src_456"}
    assert token_of(o) == "src_456"


def test_token_of_none_when_nothing_saved():
    o = {"meta_data": [], "transaction_id": ""}
    assert token_of(o) is None
