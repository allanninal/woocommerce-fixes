from restore_auto_renewal import is_wrongly_manual, has_saved_token


def sub(**over):
    base = {
        "status": "active",
        "requires_manual_renewal": True,
        "meta_data": [{"key": "_stripe_source_id", "value": "src_123"}],
    }
    base.update(over)
    return base


def test_has_token_from_source_id():
    assert has_saved_token(sub()) is True


def test_has_token_from_customer_id():
    assert has_saved_token(sub(meta_data=[{"key": "_stripe_customer_id", "value": "cus_1"}])) is True


def test_no_token_when_meta_empty():
    assert has_saved_token(sub(meta_data=[])) is False


def test_wrongly_manual_when_active_manual_and_tokened():
    assert is_wrongly_manual(sub()) is True


def test_not_flagged_when_already_automatic():
    assert is_wrongly_manual(sub(requires_manual_renewal=False)) is False


def test_not_flagged_when_no_token():
    assert is_wrongly_manual(sub(meta_data=[])) is False


def test_not_flagged_when_not_active():
    assert is_wrongly_manual(sub(status="on-hold")) is False


def test_no_token_when_value_is_empty_string():
    assert has_saved_token(sub(meta_data=[{"key": "_stripe_source_id", "value": ""}])) is False
