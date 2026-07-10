from recompute_clv import compute_customer_clv, decide


def order(**over):
    base = {
        "id": 1,
        "status": "processing",
        "total": "50.00",
        "total_refunded": "0",
    }
    base.update(over)
    return base


def test_clv_sums_paid_orders_only():
    orders = [
        order(id=1, status="processing", total="50.00"),
        order(id=2, status="pending", total="999.00"),
        order(id=3, status="completed", total="20.00"),
    ]
    total, counted, notes = compute_customer_clv(orders)
    assert total == 7000
    assert counted == 2
    assert notes == []


def test_clv_nets_out_woo_refund():
    orders = [order(id=1, status="processing", total="50.00", total_refunded="20.00")]
    total, counted, notes = compute_customer_clv(orders)
    assert total == 3000
    assert counted == 1


def test_clv_prefers_larger_stripe_refund_over_stale_woo_cache():
    orders = [order(id=1, status="processing", total="50.00", total_refunded="0")]
    total, counted, notes = compute_customer_clv(orders, {1: 5000})
    assert total == 0
    assert len(notes) == 1
    assert "order 1" in notes[0]


def test_clv_never_goes_negative_on_over_refund_data_glitch():
    orders = [order(id=1, status="processing", total="50.00", total_refunded="0")]
    total, counted, notes = compute_customer_clv(orders, {1: 999999})
    assert total == 0


def test_decide_ok_when_cache_matches():
    action, _ = decide({"total_spent": "70.00"}, 7000)
    assert action == "ok"


def test_decide_drift_when_cache_is_stale_high():
    action, reason = decide({"total_spent": "120.00"}, 7000)
    assert action == "drift"
    assert "higher" in reason


def test_decide_drift_when_cache_is_stale_low():
    action, reason = decide({"total_spent": "30.00"}, 7000)
    assert action == "drift"
    assert "lower" in reason


def test_decide_no_orders_when_both_zero():
    action, _ = decide({"total_spent": "0"}, 0)
    assert action == "no_orders"


def test_decide_respects_tolerance():
    action, _ = decide({"total_spent": "50.00"}, 5001, tolerance_cents=5)
    assert action == "ok"
