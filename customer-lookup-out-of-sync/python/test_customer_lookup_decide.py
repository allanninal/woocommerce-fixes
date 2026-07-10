from rebuild_customer_lookup import (
    decide,
    recalc_from_orders,
    stored_totals_of,
    stripe_customer_id_of,
)


def order(**over):
    base = {"total": "50.00", "date_created": "2026-06-01T10:00:00"}
    base.update(over)
    return base


def test_skip_when_stored_matches_real_orders():
    recalculated = recalc_from_orders([order()])
    stored = {"orders_count": 1, "total_spent_minor": 5000, "last_order_date": "2026-06-01T10:00:00"}
    assert decide(stored, recalculated)[0] == "skip"


def test_rebuild_when_count_differs():
    recalculated = recalc_from_orders(
        [order(), order(total="30.00", date_created="2026-06-05T10:00:00")]
    )
    stored = {"orders_count": 1, "total_spent_minor": 5000, "last_order_date": "2026-06-01T10:00:00"}
    assert decide(stored, recalculated)[0] == "rebuild"


def test_rebuild_when_total_differs_by_more_than_a_cent():
    recalculated = recalc_from_orders([order(total="50.00")])
    stored = {"orders_count": 1, "total_spent_minor": 4000, "last_order_date": "2026-06-01T10:00:00"}
    assert decide(stored, recalculated)[0] == "rebuild"


def test_skip_when_total_differs_by_rounding_only():
    recalculated = recalc_from_orders([order(total="50.00")])
    stored = {"orders_count": 1, "total_spent_minor": 5001, "last_order_date": "2026-06-01T10:00:00"}
    assert decide(stored, recalculated)[0] == "skip"


def test_rebuild_when_no_real_orders_but_stored_has_some():
    recalculated = recalc_from_orders([])
    stored = {"orders_count": 3, "total_spent_minor": 15000, "last_order_date": "2026-05-01T10:00:00"}
    action, reason = decide(stored, recalculated)
    assert action == "rebuild"
    assert "no real paid orders" in reason


def test_rebuild_when_last_order_date_differs():
    recalculated = recalc_from_orders([order(date_created="2026-06-10T10:00:00")])
    stored = {"orders_count": 1, "total_spent_minor": 5000, "last_order_date": "2026-06-01T10:00:00"}
    assert decide(stored, recalculated)[0] == "rebuild"


def test_recalc_totals_and_last_order_date():
    recalculated = recalc_from_orders([
        order(total="20.00", date_created="2026-06-01T10:00:00"),
        order(total="30.00", date_created="2026-06-10T10:00:00"),
    ])
    assert recalculated["orders_count"] == 2
    assert recalculated["total_spent_minor"] == 5000
    assert recalculated["last_order_date"] == "2026-06-10T10:00:00"


def test_recalc_with_no_orders():
    recalculated = recalc_from_orders([])
    assert recalculated == {"orders_count": 0, "total_spent_minor": 0, "last_order_date": None}


def test_stored_totals_of_normalizes_customer_record():
    customer = {"orders_count": 4, "total_spent": "120.50", "last_order_date": "2026-06-01T10:00:00"}
    stored = stored_totals_of(customer)
    assert stored == {"orders_count": 4, "total_spent_minor": 12050, "last_order_date": "2026-06-01T10:00:00"}


def test_stored_totals_of_handles_empty_total_spent():
    customer = {"orders_count": 0, "total_spent": "", "last_order_date": None}
    stored = stored_totals_of(customer)
    assert stored == {"orders_count": 0, "total_spent_minor": 0, "last_order_date": None}


def test_stripe_customer_id_from_meta():
    o = order(meta_data=[{"key": "_stripe_customer_id", "value": "cus_123"}], transaction_id="")
    assert stripe_customer_id_of(o) == "cus_123"


def test_stripe_customer_id_falls_back_to_transaction_id():
    o = order(meta_data=[], transaction_id="cus_456")
    assert stripe_customer_id_of(o) == "cus_456"


def test_stripe_customer_id_none_when_transaction_is_not_a_customer_id():
    o = order(meta_data=[], transaction_id="pi_789")
    assert stripe_customer_id_of(o) is None
