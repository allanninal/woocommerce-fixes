from export_subscriptions import plan_next_page, next_page_size, bytes_per_row_estimate


def state(**over):
    base = {
        "page_size": 100,
        "rows_in_last_page": 0,
        "last_page_bytes": 0,
        "total_rows_so_far": 0,
        "max_rows": None,
        "memory_budget_mb": 150,
        "has_fetched_a_page": False,
    }
    base.update(over)
    return base


def test_continue_on_the_first_request():
    assert plan_next_page(state())[0] == "continue"


def test_continue_when_page_fits_comfortably_in_budget():
    s = state(rows_in_last_page=100, last_page_bytes=200_000, has_fetched_a_page=True)
    assert plan_next_page(s)[0] == "continue"


def test_stop_done_when_a_page_returns_no_rows():
    s = state(rows_in_last_page=0, has_fetched_a_page=True)
    assert plan_next_page(s)[0] == "stop_done"


def test_stop_done_when_row_cap_reached():
    s = state(total_rows_so_far=500, max_rows=500)
    assert plan_next_page(s)[0] == "stop_done"


def test_shrink_when_last_page_blew_the_memory_budget():
    huge_bytes = 300 * 1024 * 1024  # 300MB, over the 150MB budget
    s = state(page_size=100, rows_in_last_page=100, last_page_bytes=huge_bytes, has_fetched_a_page=True)
    assert plan_next_page(s)[0] == "shrink"


def test_no_shrink_below_the_minimum_page_size():
    huge_bytes = 300 * 1024 * 1024
    s = state(page_size=10, rows_in_last_page=10, last_page_bytes=huge_bytes, has_fetched_a_page=True)
    # Already at MIN_PAGE_SIZE (10), so we keep going rather than shrink forever.
    assert plan_next_page(s)[0] == "continue"


def test_next_page_size_halves():
    assert next_page_size(100) == 50


def test_next_page_size_never_below_minimum():
    assert next_page_size(12) == 10  # MIN_PAGE_SIZE is 10
    assert next_page_size(4) == 10


def test_bytes_per_row_estimate_normal():
    assert bytes_per_row_estimate(1000, 100) == 10


def test_bytes_per_row_estimate_zero_rows_is_zero():
    assert bytes_per_row_estimate(1000, 0) == 0
