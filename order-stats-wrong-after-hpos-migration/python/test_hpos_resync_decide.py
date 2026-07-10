from resync_order_stats import decide, order_amount_minor, report_amount_minor


def order(**over):
    base = {"id": 501, "status": "processing", "total": "50.00"}
    base.update(over)
    return base


def report_row(**over):
    base = {"order_id": 501, "status": "processing", "total_sales": "50.00"}
    base.update(over)
    return base


def test_ok_when_row_matches_order():
    assert decide(order(), report_row())[0] == "ok"


def test_missing_when_no_stats_row_for_countable_order():
    assert decide(order(), None)[0] == "missing"


def test_resync_when_status_is_stale():
    assert decide(order(status="completed"), report_row(status="processing"))[0] == "resync"


def test_resync_when_total_mismatches():
    assert decide(order(total="80.00"), report_row(total_sales="50.00"))[0] == "resync"


def test_skip_when_status_not_counted():
    assert decide(order(status="pending"), None)[0] == "skip"


def test_skip_when_cancelled_even_with_stale_row():
    # A cancelled order should never be counted, no matter what the leftover row says.
    assert decide(order(status="cancelled"), report_row())[0] == "skip"


def test_order_amount_minor_rounds_to_cents():
    assert order_amount_minor({"total": "19.999"}) == 2000


def test_report_amount_minor_defaults_to_zero():
    assert report_amount_minor({}) == 0


def test_ok_tolerates_a_half_cent_rounding_gap():
    # abs difference of 1 minor unit or less is treated as a match
    assert decide(order(total="50.00"), report_row(total_sales="50.01"))[0] == "ok"
