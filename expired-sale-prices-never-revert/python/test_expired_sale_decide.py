from datetime import datetime, timezone

from revert_expired_sales import decide, sale_window_of, parse_gmt

NOW = datetime(2026, 7, 10, 12, 0, tzinfo=timezone.utc)


def window(**over):
    base = {
        "sale_price": "19.00",
        "regular_price": "29.00",
        "ends_at": datetime(2026, 7, 1, tzinfo=timezone.utc),
    }
    base.update(over)
    return base


def test_revert_when_end_date_passed():
    assert decide(window(), NOW)[0] == "revert"


def test_skip_when_no_sale_price():
    assert decide(window(sale_price=""), NOW)[0] == "skip"


def test_skip_when_no_end_date():
    assert decide(window(ends_at=None), NOW)[0] == "skip"


def test_skip_when_end_date_in_future():
    future = datetime(2026, 8, 1, tzinfo=timezone.utc)
    assert decide(window(ends_at=future), NOW)[0] == "skip"


def test_revert_when_end_date_is_exact_now():
    assert decide(window(ends_at=NOW), NOW)[0] == "revert"


def test_parse_gmt_none_when_missing():
    assert parse_gmt("") is None
    assert parse_gmt(None) is None


def test_parse_gmt_parses_naive_string_as_utc():
    dt = parse_gmt("2026-07-01T00:00:00")
    assert dt == datetime(2026, 7, 1, tzinfo=timezone.utc)


def test_sale_window_of_reads_expected_fields():
    product = {
        "sale_price": "19.00",
        "regular_price": "29.00",
        "date_on_sale_to_gmt": "2026-07-01T00:00:00",
    }
    window_out = sale_window_of(product)
    assert window_out["sale_price"] == "19.00"
    assert window_out["regular_price"] == "29.00"
    assert window_out["ends_at"] == datetime(2026, 7, 1, tzinfo=timezone.utc)


def test_sale_window_of_defaults_when_fields_missing():
    window_out = sale_window_of({})
    assert window_out["sale_price"] == ""
    assert window_out["regular_price"] == ""
    assert window_out["ends_at"] is None
