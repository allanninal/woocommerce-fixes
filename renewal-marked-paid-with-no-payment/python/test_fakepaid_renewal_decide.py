from flag_fake_paid_renewals import decide, intent_id_of, is_renewal, order_amount_minor


def intent(**over):
    base = {"status": "succeeded", "amount_received": 2900}
    base.update(over)
    return base


def test_ok_when_renewal_paid_and_charge_matches():
    order = {"status": "processing", "total": "29.00"}
    assert decide(order, intent())[0] == "ok"


def test_flag_when_no_intent():
    order = {"status": "completed", "total": "29.00"}
    assert decide(order, None)[0] == "flag"


def test_flag_when_intent_not_succeeded():
    order = {"status": "processing", "total": "29.00"}
    assert decide(order, intent(status="requires_payment_method"))[0] == "flag"


def test_flag_when_amount_mismatch():
    order = {"status": "processing", "total": "49.00"}
    assert decide(order, intent())[0] == "flag"


def test_skip_when_renewal_not_paid():
    order = {"status": "pending", "total": "29.00"}
    assert decide(order, None)[0] == "skip"


def test_skip_takes_priority_over_missing_intent():
    # A pending renewal with no intent is not this bug, it just has not been paid yet.
    order = {"status": "on-hold", "total": "29.00"}
    action, reason = decide(order, None)
    assert action == "skip"
    assert "not in a paid state" in reason


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_intent_id_none_when_nothing_saved():
    order = {"meta_data": [], "transaction_id": ""}
    assert intent_id_of(order) is None


def test_is_renewal_true_with_meta_key():
    order = {"meta_data": [{"key": "_subscription_renewal", "value": "12"}]}
    assert is_renewal(order) is True


def test_is_renewal_false_without_meta_key():
    order = {"meta_data": [{"key": "_some_other_key", "value": "x"}]}
    assert is_renewal(order) is False


def test_is_renewal_false_with_no_meta_at_all():
    order = {}
    assert is_renewal(order) is False


def test_order_amount_minor_converts_to_cents():
    assert order_amount_minor({"total": "29.00"}) == 2900
    assert order_amount_minor({"total": "10.5"}) == 1050
