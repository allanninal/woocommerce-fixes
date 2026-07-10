from cancel_stripe_subscription import decide, stripe_sub_id_of


def woo_sub(**over):
    base = {"id": 501, "status": "cancelled", "meta_data": []}
    base.update(over)
    return base


def stripe_sub(**over):
    base = {"id": "sub_1", "status": "active"}
    base.update(over)
    return base


def test_cancel_when_woo_cancelled_and_stripe_still_active():
    assert decide(woo_sub(), stripe_sub())[0] == "cancel"


def test_cancel_when_stripe_past_due():
    assert decide(woo_sub(status="pending-cancel"), stripe_sub(status="past_due"))[0] == "cancel"


def test_ok_when_stripe_already_canceled():
    assert decide(woo_sub(), stripe_sub(status="canceled"))[0] == "ok"


def test_skip_when_woo_subscription_not_cancelled():
    assert decide(woo_sub(status="active"), stripe_sub())[0] == "skip"


def test_orphan_when_no_stripe_subscription():
    assert decide(woo_sub(), None)[0] == "orphan"


def test_stripe_sub_id_from_meta():
    sub = {"meta_data": [{"key": "_stripe_subscription_id", "value": "sub_123"}]}
    assert stripe_sub_id_of(sub) == "sub_123"


def test_stripe_sub_id_falls_back_to_intent_meta_prefix():
    sub = {"meta_data": [{"key": "_stripe_intent_id", "value": "sub_456"}]}
    assert stripe_sub_id_of(sub) == "sub_456"


def test_stripe_sub_id_falls_back_to_transaction_id():
    sub = {"meta_data": [], "transaction_id": "sub_789"}
    assert stripe_sub_id_of(sub) == "sub_789"


def test_stripe_sub_id_none_when_nothing_matches():
    sub = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": "ch_1"}
    assert stripe_sub_id_of(sub) is None
