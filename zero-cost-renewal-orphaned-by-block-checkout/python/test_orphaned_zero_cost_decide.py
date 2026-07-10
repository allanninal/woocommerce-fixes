from complete_zero_cost_renewal import decide, intent_id_of, is_renewal_order, order_total_minor


def renewal_order(**over):
    base = {
        "status": "pending",
        "total": "0.00",
        "created_via": "subscription",
        "meta_data": [{"key": "_subscription_renewal", "value": "123"}],
    }
    base.update(over)
    return base


def test_complete_when_zero_cost_renewal_with_no_intent():
    order = renewal_order()
    assert decide(order)[0] == "complete"


def test_skip_when_not_a_renewal_order():
    order = renewal_order(meta_data=[])
    assert decide(order)[0] == "skip"


def test_skip_when_order_already_paid():
    order = renewal_order(status="processing")
    assert decide(order)[0] == "skip"


def test_skip_when_total_is_not_zero_cost():
    order = renewal_order(total="19.99")
    assert decide(order)[0] == "skip"


def test_skip_when_a_payment_intent_is_attached():
    order = renewal_order(meta_data=[
        {"key": "_subscription_renewal", "value": "123"},
        {"key": "_stripe_intent_id", "value": "pi_abc"},
    ])
    assert decide(order)[0] == "skip"


def test_review_when_created_via_is_unexpected():
    order = renewal_order(created_via="import")
    assert decide(order)[0] == "review"


def test_order_total_minor_rounds_to_cents():
    assert order_total_minor({"total": "0.00"}) == 0
    assert order_total_minor({"total": "19.99"}) == 1999


def test_intent_id_of_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_of_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_of_none_when_no_payment_reference():
    order = {"meta_data": [], "transaction_id": ""}
    assert intent_id_of(order) is None


def test_is_renewal_order_true_only_with_renewal_meta():
    assert is_renewal_order({"meta_data": [{"key": "_subscription_renewal", "value": "9"}]}) is True
    assert is_renewal_order({"meta_data": []}) is False
    assert is_renewal_order({}) is False
