from trigger_stalled_renewals import decide


def sub(**over):
    base = {"status": "active", "total": "29.00"}
    base.update(over)
    return base


def test_trigger_when_due_and_no_renewal_order():
    assert decide(sub(), False, "pm_1")[0] == "trigger"


def test_skip_when_renewal_order_already_exists():
    assert decide(sub(), True, "pm_1")[0] == "skip"


def test_skip_when_subscription_not_active():
    assert decide(sub(status="on-hold"), False, "pm_1")[0] == "skip"


def test_manual_when_no_payment_method_saved():
    assert decide(sub(), False, None)[0] == "manual"


def test_skip_when_zero_cost_renewal():
    assert decide(sub(total="0.00"), False, "pm_1")[0] == "skip"
