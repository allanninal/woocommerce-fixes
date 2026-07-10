from sync_apm_refunds import is_stripe_apm, refund_action


def test_apm_detected():
    assert is_stripe_apm("stripe_ideal") is True
    assert is_stripe_apm("stripe") is False
    assert is_stripe_apm("paypal") is False


def test_records_missing_and_marks_full():
    missing, fully = refund_action(5000, 5000, 0)
    assert missing == 5000 and fully is True


def test_partial_refund_not_full():
    missing, fully = refund_action(5000, 2000, 0)
    assert missing == 2000 and fully is False


def test_nothing_when_matched():
    missing, fully = refund_action(5000, 2000, 2000)
    assert missing == 0 and fully is False
