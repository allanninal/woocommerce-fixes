from bulk_cancel_sync import decide, stripe_sub_id_of


def woo_sub(status="active", **over):
    base = {"id": 1, "status": status}
    base.update(over)
    return base


def stripe_sub(status="active"):
    return {"id": "sub_1", "status": status}


def test_cancel_both_when_active_on_both_sides():
    assert decide(woo_sub("active"), stripe_sub("active"))[0] == "cancel_both"


def test_skip_when_already_cancelled_on_both_sides():
    assert decide(woo_sub("cancelled"), stripe_sub("canceled"))[0] == "skip"


def test_cancel_stripe_only_when_woo_already_cancelled():
    action, _ = decide(woo_sub("cancelled"), stripe_sub("active"))
    assert action == "cancel_stripe_only"


def test_cancel_woo_only_when_stripe_already_cancelled():
    action, _ = decide(woo_sub("active"), stripe_sub("canceled"))
    assert action == "cancel_woo_only"


def test_orphan_when_stripe_subscription_missing_and_woo_active():
    action, reason = decide(woo_sub("active"), None)
    assert action == "orphan"
    assert "cancel Stripe by hand" in reason


def test_orphan_when_stripe_subscription_missing_and_woo_already_cancelled():
    action, reason = decide(woo_sub("cancelled"), None)
    assert action == "orphan"
    assert "cannot confirm Stripe side" in reason


def test_orphan_when_woo_subscription_missing():
    assert decide(None, stripe_sub("active"))[0] == "orphan"


def test_incomplete_expired_counts_as_cancelled_on_stripe():
    action, _ = decide(woo_sub("active"), stripe_sub("incomplete_expired"))
    assert action == "cancel_woo_only"


def test_stripe_sub_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_subscription_id", "value": "sub_123"}], "transaction_id": ""}
    assert stripe_sub_id_of(order) == "sub_123"


def test_stripe_sub_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "sub_456"}
    assert stripe_sub_id_of(order) == "sub_456"


def test_stripe_sub_id_none_when_transaction_is_not_a_subscription():
    order = {"meta_data": [], "transaction_id": "pi_789"}
    assert stripe_sub_id_of(order) is None
