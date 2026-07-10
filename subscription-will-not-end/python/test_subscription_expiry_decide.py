from datetime import datetime, timezone

from expire_overdue_subscriptions import decide, parse_gmt, intent_id_of


NOW = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)


def sub(**over):
    base = {"status": "active", "end_date_gmt": "2026-07-01 00:00:00"}
    base.update(over)
    return base


def test_expire_when_end_date_passed_and_open():
    assert decide(sub(), NOW)[0] == "expire"


def test_skip_when_no_end_date():
    assert decide(sub(end_date_gmt="0000-00-00 00:00:00"), NOW)[0] == "skip"


def test_skip_when_end_date_missing_key():
    assert decide({"status": "active"}, NOW)[0] == "skip"


def test_skip_when_end_date_in_future():
    assert decide(sub(end_date_gmt="2026-08-01 00:00:00"), NOW)[0] == "skip"


def test_skip_when_already_expired():
    assert decide(sub(status="expired"), NOW)[0] == "skip"


def test_skip_when_cancelled():
    assert decide(sub(status="cancelled"), NOW)[0] == "skip"


def test_wait_inside_grace_window():
    # end date only nine hours ago, default grace is six hours in the module
    # but the test passes now directly, so use an end date just past the boundary
    recent = sub(end_date_gmt="2026-07-10 08:00:00")  # 4 hours ago, inside 6h grace
    assert decide(recent, NOW)[0] == "wait"


def test_expire_past_grace_window():
    old = sub(end_date_gmt="2026-07-10 04:00:00")  # 8 hours ago, past 6h grace
    assert decide(old, NOW)[0] == "expire"


def test_pending_cancel_counts_as_open():
    assert decide(sub(status="pending-cancel"), NOW)[0] == "expire"


def test_parse_gmt_handles_iso_t_and_z():
    assert parse_gmt("2026-07-01T00:00:00Z") == datetime(2026, 7, 1, tzinfo=timezone.utc)


def test_parse_gmt_none_for_zero_date():
    assert parse_gmt("0000-00-00 00:00:00") is None


def test_parse_gmt_none_for_empty():
    assert parse_gmt("") is None
    assert parse_gmt(None) is None


def test_intent_id_from_meta():
    subscription = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(subscription) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    subscription = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(subscription) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    subscription = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(subscription) is None
