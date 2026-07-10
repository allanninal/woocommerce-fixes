from datetime import datetime, timedelta, timezone

from cron_watchdog import decide, store_verdict, intent_id_of, has_email_note, minutes_waiting


def order(created_minutes_ago, **over):
    now = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)
    created = now - timedelta(minutes=created_minutes_ago)
    base = {"id": 1, "date_created_gmt": created.isoformat()}
    base.update(over)
    return base, now


def test_ok_when_email_note_present():
    o, now = order(60)
    notes = [{"note": "Order status changed from processing to completed."}]
    assert decide(o, notes, now, 30)[0] == "ok"


def test_wait_when_inside_grace_window():
    o, now = order(10)
    assert decide(o, [], now, 30)[0] == "wait"


def test_stuck_when_past_threshold_with_no_note():
    o, now = order(90)
    assert decide(o, [], now, 30)[0] == "stuck"


def test_stuck_reason_includes_minutes_waited():
    o, now = order(90)
    action, reason = decide(o, [], now, 30)
    assert action == "stuck"
    assert "90" in reason


def test_customer_note_flag_counts_as_ok():
    o, now = order(90)
    notes = [{"note": "Thanks!", "customer_note": True}]
    assert decide(o, notes, now, 30)[0] == "ok"


def test_exactly_at_threshold_counts_as_stuck():
    # wait only applies while strictly below the threshold, so waited == stuck_minutes is stuck
    o, now = order(30)
    assert decide(o, [], now, 30)[0] == "stuck"


def test_has_email_note_matches_any_marker():
    assert has_email_note([{"note": "A note sent to customer about their order."}]) is True
    assert has_email_note([{"note": "Payment via card."}]) is False
    assert has_email_note([]) is False


def test_minutes_waiting_handles_z_suffix():
    now = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)
    o = {"date_created_gmt": "2026-07-10T11:00:00"}
    assert abs(minutes_waiting(o, now) - 60) < 0.01


def test_verdict_alarm_at_threshold():
    assert store_verdict(3)[0] == "alarm"


def test_verdict_alarm_above_threshold():
    assert store_verdict(10)[0] == "alarm"


def test_verdict_watch_below_threshold():
    assert store_verdict(1)[0] == "watch"


def test_verdict_healthy_when_zero():
    assert store_verdict(0)[0] == "healthy"


def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None
