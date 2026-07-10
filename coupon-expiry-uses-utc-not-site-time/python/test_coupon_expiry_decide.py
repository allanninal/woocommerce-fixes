from fix_coupon_expiry_timezone import decide


def coupon(**over):
    base = {"id": 1, "code": "SUMMER10", "date_expires_gmt": "2026-07-10T00:00:00"}
    base.update(over)
    return base


def test_skip_when_no_expiry():
    assert decide(coupon(date_expires_gmt=""), 480)[0] == "skip"


def test_skip_when_expiry_is_none():
    assert decide(coupon(date_expires_gmt=None), 480)[0] == "skip"


def test_correct_when_positive_offset_expires_mid_day():
    # Manila, UTC+8. Midnight UTC on 2026-07-10 is 08:00 local the same
    # day, hours before end of day. Should be corrected forward.
    action, reason, corrected = decide(coupon(), 480)
    assert action == "correct"
    assert corrected == "2026-07-10T15:59:59"


def test_correct_when_negative_offset_crosses_to_wrong_day():
    # New York, UTC-5. Midnight UTC on 2026-07-10 is 19:00 local on
    # 2026-07-09, an entirely different calendar day than intended.
    action, reason, corrected = decide(coupon(), -300)
    assert action == "correct"
    assert "wrong local calendar day" in reason
    assert corrected == "2026-07-10T04:59:59"


def test_ok_when_already_end_of_local_day():
    # Already patched to expire at 23:59:59 in a UTC+8 store.
    assert decide(coupon(date_expires_gmt="2026-07-10T15:59:59"), 480)[0] == "ok"


def test_correct_even_for_utc_offset_zero():
    # Even a UTC store still expires at the start of the day, not the end,
    # unless the expiry was already set to 23:59:59.
    action, reason, corrected = decide(coupon(), 0)
    assert action == "correct"
    assert corrected == "2026-07-10T23:59:59"


def test_ok_for_utc_store_already_at_end_of_day():
    assert decide(coupon(date_expires_gmt="2026-07-10T23:59:59"), 0)[0] == "ok"
