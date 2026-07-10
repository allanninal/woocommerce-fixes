from recreate_subs import decide


def sub(**over):
    base = {"status": "active", "_stripe_customer_id": "cus_old1", "_stripe_source_id": "pm_old1"}
    base.update(over)
    return base


def token(**over):
    base = {"customer_id": "cus_new1", "payment_method_id": "pm_new1", "chargeable": True}
    base.update(over)
    return base


def test_recreate_when_new_token_available():
    assert decide(sub(), token())[0] == "recreate"


def test_skip_when_subscription_not_active():
    assert decide(sub(status="cancelled"), token())[0] == "skip"


def test_skip_when_on_hold_is_still_considered():
    assert decide(sub(status="on-hold"), token())[0] == "recreate"


def test_missing_when_no_new_token_yet():
    assert decide(sub(), None)[0] == "missing"


def test_missing_when_token_not_chargeable():
    assert decide(sub(), token(chargeable=False))[0] == "missing"


def test_skip_when_already_pointing_at_current_token():
    current = sub(_stripe_customer_id="cus_new1", _stripe_source_id="pm_new1")
    assert decide(current, token())[0] == "skip"


def test_skip_when_no_old_customer_recorded():
    assert decide(sub(_stripe_customer_id=None), token())[0] == "skip"
