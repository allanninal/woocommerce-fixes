from datetime import datetime, timezone

from cancel_stuck_pending_cancel import decide, stripe_sub_id_of, parse_gmt


NOW = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)


def sub(**over):
    base = {
        "status": "pending-cancel",
        "end_date_gmt": "2026-07-01 00:00:00",
        "meta_data": [],
    }
    base.update(over)
    return base


def stripe_sub(**over):
    base = {"status": "canceled"}
    base.update(over)
    return base


def test_skip_when_not_pending_cancel():
    assert decide(sub(status="active"), None, NOW)[0] == "skip"


def test_wait_when_end_date_in_future():
    s = sub(end_date_gmt="2026-08-01 00:00:00")
    assert decide(s, None, NOW)[0] == "wait"


def test_hold_when_no_end_date_set():
    s = sub(end_date_gmt="0000-00-00 00:00:00")
    assert decide(s, None, NOW)[0] == "hold"


def test_hold_when_end_date_empty_string():
    s = sub(end_date_gmt="")
    assert decide(s, None, NOW)[0] == "hold"


def test_cancel_when_end_passed_and_no_stripe_id():
    s = sub()
    assert decide(s, None, NOW)[0] == "cancel"


def test_cancel_when_end_passed_and_stripe_agrees_canceled():
    s = sub(meta_data=[{"key": "_stripe_subscription_id", "value": "sub_123"}])
    assert decide(s, stripe_sub(status="canceled"), NOW)[0] == "cancel"


def test_hold_when_stripe_still_active():
    s = sub(meta_data=[{"key": "_stripe_subscription_id", "value": "sub_123"}])
    assert decide(s, stripe_sub(status="active"), NOW)[0] == "hold"


def test_hold_when_stripe_past_due():
    s = sub(meta_data=[{"key": "_stripe_subscription_id", "value": "sub_123"}])
    assert decide(s, stripe_sub(status="past_due"), NOW)[0] == "hold"


def test_cancel_when_end_exactly_now():
    s = sub(end_date_gmt="2026-07-10 12:00:00")
    assert decide(s, None, NOW)[0] == "cancel"


def test_stripe_sub_id_of_from_meta():
    s = sub(meta_data=[{"key": "_stripe_subscription_id", "value": "sub_abc"}])
    assert stripe_sub_id_of(s) == "sub_abc"


def test_stripe_sub_id_of_none_when_missing():
    assert stripe_sub_id_of(sub()) is None


def test_parse_gmt_none_for_zero_date():
    assert parse_gmt("0000-00-00 00:00:00") is None


def test_parse_gmt_parses_real_date():
    dt = parse_gmt("2026-07-01 00:00:00")
    assert dt.year == 2026 and dt.month == 7 and dt.day == 1
