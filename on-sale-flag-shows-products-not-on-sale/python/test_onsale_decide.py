from datetime import datetime

from recompute_on_sale import decide, should_be_on_sale, to_minor, within_sale_window


NOW = datetime(2026, 7, 10, 12, 0, 0)


def product(**over):
    base = {
        "regular_price": "50.00",
        "sale_price": "40.00",
        "date_on_sale_from": None,
        "date_on_sale_to": None,
        "on_sale": False,
    }
    base.update(over)
    return base


def test_fix_when_should_be_on_sale_but_flag_is_false():
    p = product(on_sale=False)
    assert should_be_on_sale(p, NOW) is True
    assert decide(p, NOW)[0] == "fix"


def test_skip_when_flag_already_matches_on_sale():
    p = product(on_sale=True)
    assert decide(p, NOW)[0] == "skip"


def test_skip_when_flag_already_matches_not_on_sale():
    p = product(sale_price="", on_sale=False)
    assert decide(p, NOW)[0] == "skip"


def test_fix_when_sale_window_has_passed_but_flag_still_true():
    p = product(date_on_sale_to="2026-01-01T00:00:00", on_sale=True)
    assert should_be_on_sale(p, NOW) is False
    assert decide(p, NOW)[0] == "fix"


def test_fix_when_sale_price_not_below_regular_but_flag_true():
    p = product(sale_price="50.00", on_sale=True)
    assert should_be_on_sale(p, NOW) is False
    assert decide(p, NOW)[0] == "fix"


def test_fix_when_sale_price_above_regular_but_flag_true():
    p = product(sale_price="60.00", on_sale=True)
    assert should_be_on_sale(p, NOW) is False
    assert decide(p, NOW)[0] == "fix"


def test_skip_when_sale_starts_in_the_future_and_flag_false():
    p = product(date_on_sale_from="2026-08-01T00:00:00", on_sale=False)
    assert should_be_on_sale(p, NOW) is False
    assert decide(p, NOW)[0] == "skip"


def test_fix_when_sale_starts_in_the_future_but_flag_true():
    p = product(date_on_sale_from="2026-08-01T00:00:00", on_sale=True)
    assert should_be_on_sale(p, NOW) is False
    assert decide(p, NOW)[0] == "fix"


def test_skip_when_no_regular_price():
    p = product(regular_price="", on_sale=False)
    assert decide(p, NOW)[0] == "skip"


def test_within_sale_window_true_with_no_bounds():
    assert within_sale_window(None, None, NOW) is True


def test_within_sale_window_false_before_start():
    assert within_sale_window("2026-08-01T00:00:00", None, NOW) is False


def test_to_minor_handles_empty_and_none():
    assert to_minor("") is None
    assert to_minor(None) is None
    assert to_minor("19.99") == 1999
