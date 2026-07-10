from datetime import datetime, timezone
from fix_next_payment_drift import correct_next_payment, decide, intent_id_of


def dt(y, m, d, h=0):
    return datetime(y, m, d, h, tzinfo=timezone.utc)


def test_correct_next_payment_steps_one_month_forward():
    start = dt(2026, 1, 15)
    now = dt(2026, 3, 20)
    result = correct_next_payment(start, "month", 1, now)
    assert result == dt(2026, 4, 15)


def test_correct_next_payment_handles_month_length_change():
    start = dt(2026, 1, 31)
    now = dt(2026, 1, 31, 1)
    result = correct_next_payment(start, "month", 1, now)
    assert result == dt(2026, 2, 28)


def test_correct_next_payment_handles_week_period():
    start = dt(2026, 1, 1)
    now = dt(2026, 1, 20)
    result = correct_next_payment(start, "week", 2, now)
    assert result == dt(2026, 1, 29)


def test_correct_next_payment_handles_year_period():
    start = dt(2025, 6, 10)
    now = dt(2026, 6, 15)
    result = correct_next_payment(start, "year", 1, now)
    assert result == dt(2027, 6, 10)


def test_correct_next_payment_rejects_non_positive_interval():
    try:
        correct_next_payment(dt(2026, 1, 1), "month", 0, dt(2026, 2, 1))
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_ok_when_stored_date_matches_schedule():
    sub = {
        "status": "active", "billing_period": "month", "billing_interval": 1,
        "start_date_gmt": dt(2026, 1, 15), "next_payment_date_gmt": dt(2026, 4, 15),
    }
    assert decide(sub, dt(2026, 3, 20))[0] == "ok"


def test_fix_when_stored_date_drifted_ahead():
    sub = {
        "status": "active", "billing_period": "month", "billing_interval": 1,
        "start_date_gmt": dt(2026, 1, 15), "next_payment_date_gmt": dt(2026, 4, 18),
    }
    action, reason = decide(sub, dt(2026, 3, 20))
    assert action == "fix"
    assert "ahead" in reason


def test_fix_when_stored_date_drifted_behind():
    sub = {
        "status": "active", "billing_period": "month", "billing_interval": 1,
        "start_date_gmt": dt(2026, 1, 15), "next_payment_date_gmt": dt(2026, 4, 10),
    }
    action, reason = decide(sub, dt(2026, 3, 20))
    assert action == "fix"
    assert "behind" in reason


def test_skip_when_subscription_not_active():
    sub = {
        "status": "on-hold", "billing_period": "month", "billing_interval": 1,
        "start_date_gmt": dt(2026, 1, 15), "next_payment_date_gmt": dt(2026, 4, 15),
    }
    assert decide(sub, dt(2026, 3, 20))[0] == "skip"


def test_skip_when_no_next_payment_date_stored():
    sub = {
        "status": "active", "billing_period": "month", "billing_interval": 1,
        "start_date_gmt": dt(2026, 1, 15), "next_payment_date_gmt": None,
    }
    assert decide(sub, dt(2026, 3, 20))[0] == "skip"


def test_tolerance_allows_a_small_gap():
    sub = {
        "status": "active", "billing_period": "week", "billing_interval": 2,
        "start_date_gmt": dt(2026, 1, 1), "next_payment_date_gmt": dt(2026, 3, 26, 2),
    }
    assert decide(sub, dt(2026, 3, 20), tolerance_hours=6)[0] == "ok"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
