from find_detached_payment_methods import decide, intent_id_of


def subscription(**over):
    base = {"id": 501, "status": "active", "stripe_customer_id": "cus_1"}
    base.update(over)
    return base


def renewal_order(**over):
    base = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_1"}], "transaction_id": ""}
    base.update(over)
    return base


def payment_method(**over):
    base = {"id": "pm_1", "customer": "cus_1"}
    base.update(over)
    return base


def test_ok_when_attached_to_expected_customer():
    assert decide(subscription(), renewal_order(), payment_method())[0] == "ok"


def test_flag_when_payment_method_missing():
    assert decide(subscription(), renewal_order(), None)[0] == "flag"


def test_flag_when_payment_method_detached():
    pm = payment_method(customer=None)
    assert decide(subscription(), renewal_order(), pm)[0] == "flag"


def test_flag_when_attached_to_different_customer():
    pm = payment_method(customer="cus_999")
    assert decide(subscription(), renewal_order(), pm)[0] == "flag"


def test_skip_when_subscription_not_active():
    sub = subscription(status="cancelled")
    assert decide(sub, renewal_order(), payment_method())[0] == "skip"


def test_skip_when_no_renewal_order_yet():
    assert decide(subscription(), None, payment_method())[0] == "skip"


def test_skip_when_renewal_order_has_no_intent_id():
    order = renewal_order(meta_data=[], transaction_id="")
    assert decide(subscription(), order, payment_method())[0] == "skip"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
