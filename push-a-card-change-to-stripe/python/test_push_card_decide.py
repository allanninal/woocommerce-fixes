from push_card_to_stripe import decide, intent_id_of, customer_id_of


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000, "payment_method": "pm_new"}
    base.update(over)
    return base


def customer(default_pm):
    return {"invoice_settings": {"default_payment_method": default_pm}}


def order(**over):
    base = {"status": "processing", "total": "50.00"}
    base.update(over)
    return base


def test_push_when_stripe_default_is_the_old_card():
    assert decide(order(), intent(), customer("pm_old"))[0] == "push"


def test_already_synced_when_stripe_default_matches():
    assert decide(order(), intent(), customer("pm_new"))[0] == "already-synced"


def test_skip_when_order_not_paid():
    assert decide(order(status="pending"), intent(), customer("pm_old"))[0] == "skip"


def test_skip_when_intent_not_succeeded():
    assert decide(order(), intent(status="requires_payment_method"), customer("pm_old"))[0] == "skip"


def test_orphan_when_no_intent():
    assert decide(order(), None, customer("pm_old"))[0] == "orphan"


def test_orphan_when_intent_has_no_payment_method():
    assert decide(order(), intent(payment_method=None), customer("pm_old"))[0] == "orphan"


def test_orphan_when_no_customer():
    assert decide(order(), intent(), None)[0] == "orphan"


def test_mismatch_when_amount_differs():
    assert decide(order(total="80.00"), intent(), customer("pm_old"))[0] == "mismatch"


def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None


def test_customer_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_customer_id", "value": "cus_1"}]}
    assert customer_id_of(o) == "cus_1"


def test_customer_id_none_when_missing():
    assert customer_id_of({"meta_data": []}) is None
