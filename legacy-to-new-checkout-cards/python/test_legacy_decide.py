from repair_legacy_tokens import decide, gateway_id_of, is_legacy_shaped, is_payment_method_shaped


def token(**over):
    base = {"id": 1, "token": "pm_123", "is_default": False}
    base.update(over)
    return base


def payment_method(**over):
    base = {"object": "payment_method", "id": "pm_123", "customer": "cus_1"}
    base.update(over)
    return base


def source(**over):
    base = {"object": "source", "id": "src_123", "status": "chargeable"}
    base.update(over)
    return base


def test_keep_attached_payment_method():
    assert decide(token(token="pm_123"), payment_method())[0] == "keep"


def test_drop_payment_method_missing_on_stripe():
    assert decide(token(token="pm_123"), None)[0] == "drop"


def test_drop_payment_method_not_attached_to_customer():
    pm = payment_method(customer=None)
    assert decide(token(token="pm_123"), pm)[0] == "drop"


def test_drop_legacy_source_token():
    assert decide(token(token="src_abc"), source())[0] == "drop"


def test_drop_legacy_card_token():
    assert decide(token(token="card_abc"), None)[0] == "drop"


def test_drop_legacy_source_no_longer_chargeable():
    assert decide(token(token="src_abc"), source(status="consumed"))[0] == "drop"


def test_drop_legacy_source_missing_on_stripe():
    assert decide(token(token="src_abc"), None)[0] == "drop"


def test_skip_when_no_gateway_id():
    assert decide(token(token=""), None)[0] == "skip"


def test_skip_unrecognized_token_shape():
    assert decide(token(token="tok_weird"), None)[0] == "skip"


def test_gateway_id_of_strips_and_reads_token_field():
    assert gateway_id_of({"token": "  pm_9  "}) == "pm_9"
    assert gateway_id_of({"token": ""}) is None
    assert gateway_id_of({}) is None


def test_is_legacy_shaped():
    assert is_legacy_shaped("src_1") is True
    assert is_legacy_shaped("card_1") is True
    assert is_legacy_shaped("pm_1") is False
    assert is_legacy_shaped(None) is False


def test_is_payment_method_shaped():
    assert is_payment_method_shaped("pm_1") is True
    assert is_payment_method_shaped("src_1") is False
