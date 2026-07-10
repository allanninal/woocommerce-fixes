from strip_bad_renewal_coupons import (
    decide,
    is_renewal_order,
    bad_coupons_on_order,
    discount_minor_of,
    money_to_minor,
)


def renewal_order(**over):
    base = {
        "status": "processing",
        "meta_data": [{"key": "_subscription_renewal", "value": "123"}],
        "coupon_lines": [],
    }
    base.update(over)
    return base


def test_fix_when_one_time_coupon_on_renewal():
    order = renewal_order(coupon_lines=[
        {"id": 1, "code": "WELCOME10", "discount": "5.00"},
    ])
    types = {"welcome10": "percent"}
    action, reason, bad = decide(order, types)
    assert action == "fix"
    assert len(bad) == 1


def test_skip_when_coupon_is_a_recurring_type():
    order = renewal_order(coupon_lines=[
        {"id": 2, "code": "LOYAL5", "discount": "5.00"},
    ])
    types = {"loyal5": "recurring_percent"}
    assert decide(order, types)[0] == "skip"


def test_skip_when_order_is_not_a_renewal():
    order = {"status": "processing", "meta_data": [], "coupon_lines": [
        {"id": 3, "code": "WELCOME10", "discount": "5.00"},
    ]}
    types = {"welcome10": "percent"}
    assert decide(order, types)[0] == "skip"


def test_skip_when_no_coupons_on_the_order():
    order = renewal_order()
    assert decide(order, {})[0] == "skip"


def test_skip_when_order_is_cancelled():
    order = renewal_order(status="cancelled", coupon_lines=[
        {"id": 4, "code": "WELCOME10", "discount": "5.00"},
    ])
    types = {"welcome10": "percent"}
    assert decide(order, types)[0] == "skip"


def test_skip_when_coupon_code_is_unknown():
    # Coupon may have been deleted since; do not touch what we cannot verify.
    order = renewal_order(coupon_lines=[
        {"id": 5, "code": "GONE", "discount": "5.00"},
    ])
    assert decide(order, {})[0] == "skip"


def test_is_renewal_order_true_and_false():
    assert is_renewal_order(renewal_order()) is True
    assert is_renewal_order({"meta_data": []}) is False


def test_bad_coupons_on_order_filters_by_type():
    order = renewal_order(coupon_lines=[
        {"id": 6, "code": "ONE", "discount": "3.00"},
        {"id": 7, "code": "TWO", "discount": "4.00"},
    ])
    types = {"one": "fixed_cart", "two": "recurring_fixed_cart"}
    bad = bad_coupons_on_order(order, types)
    assert [b["id"] for b in bad] == [6]


def test_discount_minor_of_sums_in_cents():
    lines = [{"discount": "5.00"}, {"discount": "2.50"}]
    assert discount_minor_of(lines) == 750


def test_money_to_minor_rounds_to_cents():
    assert money_to_minor("19.999") == 2000
    assert money_to_minor("0") == 0
