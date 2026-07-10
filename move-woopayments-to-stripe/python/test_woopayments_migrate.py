from migrate_woopayments_tokens import decide, token_gateway, token_pm_id


def token(**over):
    base = {"id": 9, "gateway_id": "woocommerce_payments", "token": "pm_1MigratedCard"}
    base.update(over)
    return base


def test_repoint_when_pm_confirmed_on_new_account():
    pm = {"status": "attached", "id": "pm_1MigratedCard"}
    assert decide(token(), pm)[0] == "repoint"


def test_missing_when_pm_not_found_on_new_account():
    assert decide(token(), None)[0] == "missing"


def test_missing_when_pm_is_detached_on_new_account():
    pm = {"status": "detached", "id": "pm_1MigratedCard"}
    assert decide(token(), pm)[0] == "missing"


def test_skip_when_token_not_on_woopayments_gateway():
    t = token(gateway_id="stripe")
    pm = {"status": "attached", "id": "pm_1MigratedCard"}
    assert decide(t, pm)[0] == "skip"


def test_skip_when_token_has_no_pm_id():
    t = token(token="")
    assert decide(t, None)[0] == "skip"


def test_woopayments_alias_gateway_is_also_matched():
    t = token(gateway_id="woopayments")
    pm = {"status": "attached", "id": "pm_1MigratedCard"}
    assert decide(t, pm)[0] == "repoint"


def test_token_gateway_reads_gateway_id():
    assert token_gateway({"gateway_id": "woocommerce_payments"}) == "woocommerce_payments"


def test_token_gateway_falls_back_to_gateway_key():
    assert token_gateway({"gateway": "woocommerce_payments"}) == "woocommerce_payments"


def test_token_pm_id_reads_token_field():
    assert token_pm_id({"token": "pm_abc"}) == "pm_abc"
