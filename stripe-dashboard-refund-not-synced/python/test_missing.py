from sync_refunds import missing_refund_minor


def test_records_full_amount_when_woo_has_none():
    assert missing_refund_minor(5000, []) == 5000


def test_nothing_missing_when_amounts_match():
    assert missing_refund_minor(5000, [{"amount": "50.00"}]) == 0


def test_records_only_the_gap():
    assert missing_refund_minor(5000, [{"amount": "20.00"}]) == 3000


def test_ignores_rounding_within_tolerance():
    assert missing_refund_minor(5000, [{"amount": "50.00"}]) == 0
