from reactivate_paid_subs import should_reactivate


def test_reactivate_when_order_paid():
    assert should_reactivate("on-hold", True, False) is True


def test_reactivate_when_stripe_paid():
    assert should_reactivate("on-hold", False, True) is True


def test_leave_when_not_paid():
    assert should_reactivate("on-hold", False, False) is False


def test_ignore_non_on_hold():
    assert should_reactivate("active", True, True) is False
