from backfill_intent_id import get_meta, needs_backfill


def order(**over):
    base = {"payment_method": "stripe", "status": "pending", "meta_data": []}
    base.update(over)
    return base


def test_needs_backfill_when_id_missing():
    assert needs_backfill(order()) is True


def test_skip_when_id_present():
    o = order(meta_data=[{"key": "_stripe_intent_id", "value": "pi_1"}])
    assert needs_backfill(o) is False


def test_skip_when_already_paid():
    assert needs_backfill(order(status="processing")) is False


def test_skip_non_stripe():
    assert needs_backfill(order(payment_method="paypal")) is False


def test_get_meta_reads_value():
    o = order(meta_data=[{"key": "_stripe_charge_id", "value": "ch_9"}])
    assert get_meta(o, "_stripe_charge_id") == "ch_9"
