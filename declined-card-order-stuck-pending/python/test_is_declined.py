from fail_declined import is_declined


def test_declined_when_error_present():
    intent = {"status": "requires_payment_method", "last_payment_error": {"code": "card_declined"}}
    assert is_declined(intent) is True


def test_not_declined_without_error():
    assert is_declined({"status": "requires_payment_method", "last_payment_error": None}) is False


def test_not_declined_when_waiting_on_3ds():
    assert is_declined({"status": "requires_action", "last_payment_error": None}) is False


def test_not_declined_when_succeeded():
    assert is_declined({"status": "succeeded"}) is False
