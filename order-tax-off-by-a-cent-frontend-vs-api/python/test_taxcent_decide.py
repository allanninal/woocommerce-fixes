from reconcile_order_tax import decide, expected_tax_minor, to_minor, minor_to_amount


def line_item(rate_totals):
    return {"taxes": {"total": rate_totals}}


def order(status="processing", total_tax="5.00", line_items=None, shipping_lines=None, fee_lines=None):
    return {
        "status": status,
        "total_tax": total_tax,
        "line_items": line_items or [],
        "shipping_lines": shipping_lines or [],
        "fee_lines": fee_lines or [],
    }


def test_ok_when_tax_matches_line_items():
    o = order(total_tax="5.00", line_items=[line_item({"1": "3.00"}), line_item({"1": "2.00"})])
    assert decide(o)[0] == "ok"


def test_fix_when_off_by_one_cent():
    # Line items round to 2.50 + 2.49 = 4.99, but the stored total_tax is 5.00.
    o = order(total_tax="5.00", line_items=[line_item({"1": "2.495"}), line_item({"1": "2.494"})])
    action, reason = decide(o)
    assert action == "fix"
    assert "1 cent" in reason


def test_review_when_drift_too_large():
    o = order(total_tax="8.00", line_items=[line_item({"1": "3.00"}), line_item({"1": "2.00"})])
    assert decide(o)[0] == "review"


def test_skip_when_order_not_settled():
    o = order(status="pending", total_tax="5.00", line_items=[line_item({"1": "5.00"})])
    assert decide(o)[0] == "skip"


def test_shipping_and_fee_lines_are_included():
    o = order(
        total_tax="6.00",
        line_items=[line_item({"1": "3.00"})],
        shipping_lines=[line_item({"1": "2.00"})],
        fee_lines=[line_item({"1": "1.00"})],
    )
    assert decide(o)[0] == "ok"


def test_expected_tax_minor_sums_multiple_rates():
    o = order(line_items=[line_item({"1": "1.00", "2": "0.50"})])
    assert expected_tax_minor(o) == 150


def test_to_minor_rounds_half_away_from_zero():
    assert to_minor("2.495") == 250
    assert to_minor("2.005") == 201


def test_minor_to_amount_round_trip():
    assert minor_to_amount(500) == "5.00"
    assert minor_to_amount(-3) == "-0.03"
    assert minor_to_amount(7) == "0.07"
