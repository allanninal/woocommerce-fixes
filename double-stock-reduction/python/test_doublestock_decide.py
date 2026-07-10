from repair_double_stock import decide


def order(**over):
    base = {"status": "processing"}
    base.update(over)
    return base


def test_fix_when_reduced_exactly_twice():
    action, reason, extra = decide(order(), 3, 6)
    assert action == "fix"
    assert extra == 3


def test_fix_when_reduced_three_times():
    action, reason, extra = decide(order(), 2, 6)
    assert action == "fix"
    assert extra == 4


def test_skip_when_reduction_matches_order():
    action, reason, extra = decide(order(), 3, 3)
    assert action == "skip"
    assert extra == 0


def test_skip_when_reduction_under_order_total():
    action, reason, extra = decide(order(), 5, 3)
    assert action == "skip"
    assert extra == 0


def test_review_when_not_a_clean_multiple():
    action, reason, extra = decide(order(), 3, 7)
    assert action == "review"
    assert extra == 0


def test_skip_when_order_not_in_reduced_state():
    action, reason, extra = decide(order(status="pending"), 3, 6)
    assert action == "skip"


def test_skip_when_no_recorded_reduction():
    action, reason, extra = decide(order(), 3, None)
    assert action == "skip"


def test_skip_when_no_expected_qty():
    action, reason, extra = decide(order(), 0, 6)
    assert action == "skip"


def test_orphan_when_order_missing():
    action, reason, extra = decide(None, 3, 6)
    assert action == "orphan"
