from release_failed_coupons import decide, intent_id_of, order_customer_key


def intent(**over):
    base = {"status": "requires_payment_method"}
    base.update(over)
    return base


def coupon(**over):
    base = {"used_by": ["shopper@example.com"], "usage_count": 1}
    base.update(over)
    return base


def order(**over):
    base = {"status": "failed", "billing": {"email": "shopper@example.com"}, "customer_id": 0}
    base.update(over)
    return base


def test_release_when_failed_and_intent_not_succeeded():
    assert decide(order(), intent(), coupon())[0] == "release"


def test_release_when_no_intent_at_all():
    assert decide(order(), None, coupon())[0] == "release"


def test_skip_when_order_not_failed_or_cancelled():
    assert decide(order(status="processing"), intent(), coupon())[0] == "skip"


def test_skip_when_stripe_actually_succeeded():
    assert decide(order(), intent(status="succeeded"), coupon())[0] == "skip"


def test_skip_when_already_released():
    c = coupon(used_by=[])
    assert decide(order(), intent(), c)[0] == "skip"


def test_skip_when_no_identity_to_match():
    o = order(billing={"email": ""}, customer_id=0)
    assert decide(o, intent(), coupon())[0] == "skip"


def test_cancelled_order_also_eligible():
    assert decide(order(status="cancelled"), intent(), coupon())[0] == "release"


def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None


def test_customer_key_prefers_email():
    o = {"billing": {"email": "a@b.com"}, "customer_id": 7}
    assert order_customer_key(o) == "a@b.com"


def test_customer_key_falls_back_to_customer_id():
    o = {"billing": {"email": ""}, "customer_id": 7}
    assert order_customer_key(o) == "7"


def test_customer_key_none_when_no_identity():
    o = {"billing": {"email": ""}, "customer_id": 0}
    assert order_customer_key(o) is None
