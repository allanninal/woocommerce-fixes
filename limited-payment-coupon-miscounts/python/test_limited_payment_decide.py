from recount_limited_payment_coupons import (
    decide,
    stored_counter,
    order_applied_coupon,
    true_payment_count,
    intent_id_of,
)


def subscription(counter=None, code="vip10"):
    meta = []
    if counter is not None:
        meta.append({"key": f"_coupon_number_payments_{code.lower()}", "value": str(counter)})
    return {"id": 42, "meta_data": meta}


def order(status="processing", code="vip10", intent_id="pi_1"):
    o = {"status": status, "coupon_lines": [{"code": code}]}
    if intent_id is not None:
        o["meta_data"] = [{"key": "_stripe_intent_id", "value": intent_id}]
    return o


def test_stored_counter_reads_the_right_meta_key():
    sub = subscription(counter=3)
    assert stored_counter(sub, "VIP10") == 3


def test_stored_counter_none_when_missing():
    sub = subscription(counter=None)
    assert stored_counter(sub, "vip10") is None


def test_order_applied_coupon_is_case_insensitive():
    assert order_applied_coupon(order(code="VIP10"), "vip10") is True
    assert order_applied_coupon(order(code="other"), "vip10") is False


def test_true_payment_count_only_counts_paid_orders_with_the_coupon():
    orders = [
        order(status="processing", intent_id="pi_1"),
        order(status="pending", intent_id="pi_2"),
        order(status="processing", code="other", intent_id="pi_3"),
    ]
    verified = {"pi_1", "pi_2", "pi_3"}
    assert true_payment_count(orders, "vip10", verified) == 1


def test_true_payment_count_skips_orders_stripe_does_not_confirm():
    orders = [order(status="processing", intent_id="pi_1"), order(status="processing", intent_id="pi_2")]
    verified = {"pi_1"}  # pi_2 was never confirmed succeeded by Stripe
    assert true_payment_count(orders, "vip10", verified) == 1


def test_decide_skip_when_counter_matches():
    sub = subscription(counter=2)
    assert decide(sub, "vip10", 2)[0] == "skip"


def test_decide_repair_when_counter_is_ahead():
    sub = subscription(counter=5)
    action, reason = decide(sub, "vip10", 2)
    assert action == "repair"
    assert "ahead of" in reason


def test_decide_repair_when_counter_is_behind():
    sub = subscription(counter=1)
    action, reason = decide(sub, "vip10", 3)
    assert action == "repair"
    assert "behind" in reason


def test_decide_unknown_when_no_counter_stored():
    sub = subscription(counter=None)
    assert decide(sub, "vip10", 2)[0] == "unknown"


def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None
