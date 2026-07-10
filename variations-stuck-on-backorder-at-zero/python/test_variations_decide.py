from fix_variation_stock_status import decide, expected_stock_status


def variation(**over):
    base = {
        "id": 501,
        "manage_stock": True,
        "stock_quantity": 0,
        "backorders": "no",
        "stock_status": "onbackorder",
    }
    base.update(over)
    return base


def test_fix_when_onbackorder_at_zero_with_backorders_off():
    v = variation()
    action, reason = decide(v)
    assert action == "fix"
    assert expected_stock_status(v) == "outofstock"


def test_skip_when_status_already_outofstock():
    v = variation(stock_status="outofstock")
    assert decide(v)[0] == "skip"


def test_skip_when_backorders_allowed_and_status_matches():
    v = variation(backorders="yes", stock_status="onbackorder")
    assert decide(v)[0] == "skip"


def test_fix_when_backorders_notify_but_status_says_outofstock():
    v = variation(backorders="notify", stock_status="outofstock")
    action, reason = decide(v)
    assert action == "fix"
    assert expected_stock_status(v) == "onbackorder"


def test_fix_when_in_stock_quantity_but_marked_outofstock():
    v = variation(stock_quantity=5, stock_status="outofstock")
    action, reason = decide(v)
    assert action == "fix"
    assert expected_stock_status(v) == "instock"


def test_skip_when_variation_does_not_manage_stock():
    v = variation(manage_stock=False)
    assert decide(v)[0] == "skip"
    assert expected_stock_status(v) is None


def test_skip_when_quantity_missing():
    v = variation(stock_quantity=None)
    assert decide(v)[0] == "skip"


def test_fix_when_negative_quantity_and_backorders_off():
    v = variation(stock_quantity=-2, backorders="no", stock_status="onbackorder")
    action, reason = decide(v)
    assert action == "fix"
    assert expected_stock_status(v) == "outofstock"


def test_fix_when_status_is_an_unrecognized_value():
    v = variation(stock_status="")
    assert decide(v)[0] == "fix"
