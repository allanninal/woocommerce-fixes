from restore_sepa_renewal import decide, customer_id_of


def payment_method(**over):
    base = {"id": "pm_1", "sepa_debit": {"last4": "1234"}, "disabled": False}
    base.update(over)
    return base


def test_repair_when_manual_and_mandate_attached():
    sub = {"status": "active", "requires_manual_renewal": True}
    assert decide(sub, payment_method())[0] == "repair"


def test_skip_when_already_automatic():
    sub = {"status": "active", "requires_manual_renewal": False}
    assert decide(sub, payment_method())[0] == "skip"


def test_skip_when_not_active():
    sub = {"status": "on-hold", "requires_manual_renewal": True}
    assert decide(sub, payment_method())[0] == "skip"


def test_hold_when_no_payment_method():
    sub = {"status": "active", "requires_manual_renewal": True}
    assert decide(sub, None)[0] == "hold"


def test_hold_when_payment_method_disabled():
    sub = {"status": "active", "requires_manual_renewal": True}
    assert decide(sub, payment_method(disabled=True))[0] == "hold"


def test_customer_id_from_meta():
    sub = {"meta_data": [{"key": "_stripe_customer_id", "value": "cus_123"}]}
    assert customer_id_of(sub) == "cus_123"


def test_customer_id_none_when_missing():
    sub = {"meta_data": [{"key": "_other_key", "value": "x"}]}
    assert customer_id_of(sub) is None
