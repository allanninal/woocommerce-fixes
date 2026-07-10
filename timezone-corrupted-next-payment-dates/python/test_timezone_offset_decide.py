from datetime import datetime, timezone

from fix_next_payment_timezone import decide, expected_next_payment, hours_offset, parse_woo_date


def dt(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=timezone.utc)


def subscription(**over):
    base = {"id": 501, "status": "active", "next_payment_date_gmt": "2026-08-10T00:00:00"}
    base.update(over)
    return base


def test_ok_when_saved_matches_expected():
    expected = dt(2026, 8, 10, 0, 0)
    sub = subscription(next_payment_date_gmt="2026-08-10T00:00:00")
    action, reason, corrected = decide(sub, expected)
    assert action == "ok"
    assert corrected is None


def test_repair_when_off_by_one_site_offset():
    # Site is UTC+8. The saved date was written 8 hours ahead of the true UTC value.
    expected = dt(2026, 8, 10, 0, 0)
    sub = subscription(next_payment_date_gmt="2026-08-10T08:00:00")
    action, reason, corrected = decide(sub, expected, site_utc_offset_hours=8)
    assert action == "repair"
    assert corrected == "2026-08-10T00:00:00"


def test_repair_when_off_by_two_times_the_offset():
    # A double-applied conversion: 16 hours off on a UTC+8 site.
    expected = dt(2026, 8, 10, 0, 0)
    sub = subscription(next_payment_date_gmt="2026-08-10T16:00:00")
    action, reason, corrected = decide(sub, expected, site_utc_offset_hours=8, max_offset_multiple=2)
    assert action == "repair"
    assert corrected == "2026-08-10T00:00:00"


def test_repair_handles_negative_site_offset():
    # Site is UTC-5. Saved date drifted 5 hours behind the true UTC value.
    expected = dt(2026, 8, 10, 12, 0)
    sub = subscription(next_payment_date_gmt="2026-08-10T07:00:00")
    action, reason, corrected = decide(sub, expected, site_utc_offset_hours=-5)
    assert action == "repair"
    assert corrected == "2026-08-10T12:00:00"


def test_flag_when_offset_does_not_match_a_clean_multiple():
    expected = dt(2026, 8, 10, 0, 0)
    sub = subscription(next_payment_date_gmt="2026-08-10T03:00:00")
    action, reason, corrected = decide(sub, expected, site_utc_offset_hours=8)
    assert action == "flag"
    assert corrected is None


def test_skip_when_subscription_not_active():
    expected = dt(2026, 8, 10, 0, 0)
    sub = subscription(status="cancelled")
    action, reason, corrected = decide(sub, expected)
    assert action == "skip"


def test_skip_when_no_saved_date():
    expected = dt(2026, 8, 10, 0, 0)
    sub = subscription(next_payment_date_gmt=None)
    action, reason, corrected = decide(sub, expected)
    assert action == "skip"


def test_skip_when_no_expected_date_to_compare():
    sub = subscription()
    action, reason, corrected = decide(sub, None)
    assert action == "skip"


def test_within_tolerance_counts_as_ok():
    expected = dt(2026, 8, 10, 0, 0)
    sub = subscription(next_payment_date_gmt="2026-08-10T00:03:00")
    action, reason, corrected = decide(sub, expected, tolerance_minutes=5)
    assert action == "ok"


def test_expected_next_payment_adds_billing_interval_days():
    last_paid = dt(2026, 7, 10, 0, 0)
    result = expected_next_payment(last_paid, 1, "month")
    assert result == dt(2026, 8, 9, 0, 0)


def test_expected_next_payment_handles_multi_interval():
    last_paid = dt(2026, 1, 1, 0, 0)
    result = expected_next_payment(last_paid, 3, "month")
    assert result == dt(2026, 4, 1, 0, 0)


def test_hours_offset_is_signed():
    expected = dt(2026, 8, 10, 0, 0)
    actual = dt(2026, 8, 10, 8, 0)
    assert hours_offset(expected, actual) == 8.0
    assert hours_offset(actual, expected) == -8.0


def test_parse_woo_date_returns_none_for_empty():
    assert parse_woo_date(None) is None
    assert parse_woo_date("") is None


def test_parse_woo_date_is_utc_aware():
    parsed = parse_woo_date("2026-08-10T00:00:00")
    assert parsed.tzinfo == timezone.utc
