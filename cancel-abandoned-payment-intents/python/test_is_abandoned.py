from cancel_abandoned import is_abandoned


def test_abandoned_when_old_and_no_error():
    assert is_abandoned({"status": "requires_payment_method"}, 24, 12) is True


def test_not_abandoned_when_recent():
    assert is_abandoned({"status": "requires_payment_method"}, 2, 12) is False


def test_not_abandoned_when_declined():
    intent = {"status": "requires_payment_method", "last_payment_error": {"code": "card_declined"}}
    assert is_abandoned(intent, 24, 12) is False


def test_not_abandoned_when_succeeded():
    assert is_abandoned({"status": "succeeded"}, 24, 12) is False
