from reconcile_schedule_dates import decide, intent_id_of, hpos_next_payment_ts, meta_next_payment_ts


def subscription(**over):
    base = {
        "status": "active",
        "schedule_next_payment": "2026-08-10T00:00:00",
        "meta_data": [{"key": "_schedule_next_payment", "value": "2026-08-10T00:00:00"}],
    }
    base.update(over)
    return base


def test_ok_when_hpos_and_meta_agree_and_schedule_is_ahead():
    sub = subscription()
    last_charge_ts = hpos_next_payment_ts(sub) - 30 * 86400
    assert decide(sub, last_charge_ts)[0] == "ok"


def test_skip_when_subscription_not_active():
    sub = subscription(status="cancelled")
    assert decide(sub, None)[0] == "skip"


def test_skip_when_no_hpos_schedule_date():
    sub = subscription(schedule_next_payment=None)
    assert decide(sub, None)[0] == "skip"


def test_diverged_when_hpos_and_meta_disagree():
    sub = subscription(
        schedule_next_payment="2026-08-10T00:00:00",
        meta_data=[{"key": "_schedule_next_payment", "value": "2026-07-01T00:00:00"}],
    )
    assert decide(sub, None)[0] == "diverged"


def test_ok_when_drift_is_within_tolerance():
    # A few minutes of drift (well under the default hour tolerance) should not trip.
    sub = subscription(
        schedule_next_payment="2026-08-10T00:00:00",
        meta_data=[{"key": "_schedule_next_payment", "value": "2026-08-10T00:05:00"}],
    )
    last_charge_ts = hpos_next_payment_ts(sub) - 30 * 86400
    assert decide(sub, last_charge_ts)[0] == "ok"


def test_stale_when_schedule_is_not_after_last_charge():
    sub = subscription()
    last_charge_ts = hpos_next_payment_ts(sub) + 3600  # charge happened after the "next" date
    assert decide(sub, last_charge_ts)[0] == "stale"


def test_stale_when_schedule_equals_last_charge():
    sub = subscription()
    last_charge_ts = hpos_next_payment_ts(sub)
    assert decide(sub, last_charge_ts)[0] == "stale"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_meta_next_payment_ts_returns_none_when_missing():
    sub = subscription(meta_data=[])
    assert meta_next_payment_ts(sub) is None


def test_hpos_next_payment_ts_parses_iso_datetime():
    sub = subscription(schedule_next_payment="2026-08-10T00:00:00")
    assert hpos_next_payment_ts(sub) == 1786320000
