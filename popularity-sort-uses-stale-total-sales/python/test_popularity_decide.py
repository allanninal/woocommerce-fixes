from recount_total_sales import decide, net_quantity


def test_skip_when_totals_match():
    assert decide(12, 12)[0] == "skip"


def test_fix_when_stored_is_lower_than_real():
    assert decide(3, 40)[0] == "fix"


def test_fix_when_stored_is_higher_than_real():
    assert decide(40, 3)[0] == "fix"


def test_fix_when_stored_is_missing():
    assert decide(None, 5)[0] == "fix"


def test_skip_when_stored_is_missing_and_real_is_zero():
    assert decide(None, 0)[0] == "skip"


def test_negative_real_total_is_floored_at_zero():
    # A refund heavy product can compute negative net units; never store a
    # negative sales count.
    action, reason = decide(0, -4)
    assert action == "skip"
    assert reason == "total_sales already correct"


def test_net_quantity_reads_order_line_item():
    assert net_quantity({"quantity": 3}) == 3


def test_net_quantity_reads_negative_refund_line_item():
    assert net_quantity({"quantity": -2}) == -2


def test_net_quantity_defaults_to_zero_when_missing():
    assert net_quantity({}) == 0
