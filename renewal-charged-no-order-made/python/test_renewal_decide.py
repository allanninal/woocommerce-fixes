from create_missing_renewal import decide, amount_minor_from_decimal, intent_id_of


def intent(**over):
    base = {"status": "succeeded", "id": "pi_1"}
    base.update(over)
    return base


def test_create_when_charged_and_no_order():
    subscription = {"id": 42, "customer_id": 7}
    assert decide(subscription, intent(), False)[0] == "create"


def test_skip_when_order_already_exists():
    subscription = {"id": 42, "customer_id": 7}
    assert decide(subscription, intent(), True)[0] == "skip"


def test_skip_when_intent_not_succeeded():
    subscription = {"id": 42, "customer_id": 7}
    assert decide(subscription, intent(status="requires_payment_method"), False)[0] == "skip"


def test_orphan_when_subscription_missing():
    assert decide(None, intent(), False)[0] == "orphan"


def test_orphan_takes_priority_only_after_succeeded_check():
    # A subscription that is missing but whose intent never succeeded should
    # still be a plain skip, not an orphan, since there is nothing to reconcile.
    assert decide(None, intent(status="requires_payment_method"), False)[0] == "skip"


def test_amount_minor_from_decimal():
    assert amount_minor_from_decimal("49.99") == 4999
    assert amount_minor_from_decimal("10") == 1000


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
