from backfill_sub_token import needs_token_backfill


def sub(**over):
    base = {"payment_method": "stripe", "status": "active", "meta_data": []}
    base.update(over)
    return base


def test_needs_backfill_when_no_customer():
    assert needs_token_backfill(sub()) is True


def test_skip_when_customer_present():
    s = sub(meta_data=[{"key": "_stripe_customer_id", "value": "cus_1"}])
    assert needs_token_backfill(s) is False


def test_skip_cancelled():
    assert needs_token_backfill(sub(status="cancelled")) is False


def test_skip_non_stripe():
    assert needs_token_backfill(sub(payment_method="paypal")) is False
