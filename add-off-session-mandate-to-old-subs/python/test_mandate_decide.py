from attach_off_session_mandate import decide


def subscription(**over):
    base = {"id": 501, "status": "active"}
    base.update(over)
    return base


def payment_method(**over):
    base = {"id": "pm_1", "type": "card", "customer": "cus_1", "off_session_mandate": None}
    base.update(over)
    return base


def test_attach_mandate_when_card_has_none():
    assert decide(subscription(), payment_method())[0] == "attach_mandate"


def test_ok_when_mandate_already_exists():
    pm = payment_method(off_session_mandate="seti_123")
    assert decide(subscription(), pm)[0] == "ok"


def test_no_payment_method_when_none_saved():
    assert decide(subscription(), None)[0] == "no_payment_method"


def test_skip_when_subscription_not_active():
    sub = subscription(status="cancelled")
    assert decide(sub, payment_method())[0] == "skip"


def test_attach_mandate_for_on_hold_subscription():
    sub = subscription(status="on-hold")
    assert decide(sub, payment_method())[0] == "attach_mandate"


def test_skip_for_unsupported_payment_method_type():
    pm = payment_method(type="alipay")
    assert decide(subscription(), pm)[0] == "skip"
