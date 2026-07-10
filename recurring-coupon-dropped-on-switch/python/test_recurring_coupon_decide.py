from reapply_switch_coupon import decide, before_codes_of, recurring_coupon_codes, intent_id_of


def intent(**over):
    base = {"status": "succeeded", "id": "pi_1"}
    base.update(over)
    return base


def test_reapply_when_coupon_dropped_and_switch_succeeded():
    action, reason, dropped = decide(["vip10"], [], intent())
    assert action == "reapply"
    assert dropped == ["vip10"]


def test_skip_when_no_coupon_was_dropped():
    action, reason, dropped = decide(["vip10"], ["vip10"], intent())
    assert action == "skip"
    assert dropped == []


def test_skip_when_no_stripe_payment_found():
    action, reason, dropped = decide(["vip10"], [], None)
    assert action == "skip"


def test_skip_when_switch_payment_not_succeeded():
    action, reason, dropped = decide(["vip10"], [], intent(status="requires_action"))
    assert action == "skip"


def test_multiple_dropped_coupons_are_all_reported():
    action, reason, dropped = decide(["vip10", "loyalty5"], [], intent())
    assert action == "reapply"
    assert dropped == ["loyalty5", "vip10"]


def test_before_codes_of_reads_switch_meta():
    order = {"meta_data": [{"key": "_switch_recurring_coupons", "value": ["vip10"]}]}
    assert before_codes_of(order) == ["vip10"]


def test_before_codes_of_empty_when_missing():
    assert before_codes_of({"meta_data": []}) == []


def test_recurring_coupon_codes_reads_subscription_coupon_lines():
    subscription = {"coupon_lines": [{"code": "vip10"}, {"code": "loyalty5"}]}
    assert recurring_coupon_codes(subscription) == ["loyalty5", "vip10"]


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
