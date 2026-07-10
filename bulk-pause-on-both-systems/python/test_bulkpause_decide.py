from bulk_pause import decide, stripe_sub_id_of


def stripe_sub(**over):
    base = {"status": "active", "pause_collection": None}
    base.update(over)
    return base


def test_pause_when_both_active():
    subscription = {"status": "active"}
    assert decide(subscription, stripe_sub())[0] == "pause"


def test_skip_when_woo_already_on_hold():
    subscription = {"status": "on-hold"}
    assert decide(subscription, stripe_sub())[0] == "skip"


def test_skip_when_woo_cancelled():
    subscription = {"status": "cancelled"}
    assert decide(subscription, stripe_sub())[0] == "skip"


def test_skip_when_stripe_already_paused():
    subscription = {"status": "active"}
    assert decide(subscription, stripe_sub(pause_collection={"behavior": "void"}))[0] == "skip"


def test_skip_when_stripe_canceled():
    subscription = {"status": "active"}
    assert decide(subscription, stripe_sub(status="canceled"))[0] == "skip"


def test_orphan_when_no_stripe_subscription():
    subscription = {"status": "active"}
    assert decide(subscription, None)[0] == "orphan"


def test_stripe_sub_id_from_meta():
    subscription = {"meta_data": [{"key": "_stripe_subscription_id", "value": "sub_123"}], "transaction_id": ""}
    assert stripe_sub_id_of(subscription) == "sub_123"


def test_stripe_sub_id_falls_back_to_transaction_id():
    subscription = {"meta_data": [], "transaction_id": "sub_456"}
    assert stripe_sub_id_of(subscription) == "sub_456"


def test_stripe_sub_id_none_when_transaction_is_not_a_subscription():
    subscription = {"meta_data": [], "transaction_id": "pi_789"}
    assert stripe_sub_id_of(subscription) is None
