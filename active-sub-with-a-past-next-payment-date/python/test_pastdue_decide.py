from datetime import datetime, timedelta, timezone

from fix_past_next_payment import decide, advance

NOW = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)


def sub(**over):
    base = {
        "status": "active",
        "next_payment": NOW - timedelta(days=10),
        "billing_period": "month",
        "billing_interval": 1,
    }
    base.update(over)
    return base


def test_reschedule_when_active_and_past_due():
    action, _, fixed = decide(sub(), NOW)
    assert action == "reschedule"
    assert fixed > NOW


def test_skip_when_not_active():
    action, _, fixed = decide(sub(status="on-hold"), NOW)
    assert action == "skip"
    assert fixed is None


def test_skip_when_cancelled():
    action, _, _ = decide(sub(status="cancelled"), NOW)
    assert action == "skip"


def test_skip_when_next_payment_in_future():
    action, _, _ = decide(sub(next_payment=NOW + timedelta(days=5)), NOW)
    assert action == "skip"


def test_skip_when_next_payment_missing():
    action, _, _ = decide(sub(next_payment=None), NOW)
    assert action == "skip"


def test_skip_when_renewal_in_progress():
    action, reason, fixed = decide(sub(), NOW, renewal_in_progress=True)
    assert action == "skip"
    assert "in progress" in reason
    assert fixed is None


def test_skip_when_billing_schedule_unknown():
    action, _, _ = decide(sub(billing_period="fortnight"), NOW)
    assert action == "skip"


def test_advance_steps_by_whole_periods():
    old = NOW - timedelta(days=95)  # about 3 monthly periods behind
    fixed = advance(old, "month", 1, NOW)
    assert fixed > NOW
    assert (fixed - old).days % 30 == 0


def test_advance_respects_multi_month_interval():
    old = NOW - timedelta(days=200)
    fixed = advance(old, "month", 3, NOW)
    assert fixed > NOW
    assert (fixed - old).days % 90 == 0


def test_advance_returns_unchanged_when_already_future():
    future = NOW + timedelta(days=5)
    assert advance(future, "month", 1, NOW) == future


def test_advance_weekly_period():
    old = NOW - timedelta(days=22)  # a bit more than 3 weeks behind
    fixed = advance(old, "week", 1, NOW)
    assert fixed > NOW
    assert (fixed - old).days % 7 == 0
