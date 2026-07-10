from fix_zero_decimal_overcharge import (
    decide,
    is_zero_decimal,
    expected_minor_units,
    intent_id_of,
)


def intent(**over):
    base = {"id": "pi_1", "status": "succeeded", "amount_received": 500000, "amount_refunded": 0}
    base.update(over)
    return base


def jpy_order(**over):
    base = {"status": "processing", "currency": "JPY", "total": "5000"}
    base.update(over)
    return base


def test_is_zero_decimal_is_case_insensitive():
    assert is_zero_decimal("jpy") is True
    assert is_zero_decimal("JPY") is True
    assert is_zero_decimal("usd") is False
    assert is_zero_decimal(None) is False


def test_expected_minor_units_zero_decimal_uses_total_as_is():
    assert expected_minor_units("5000", "JPY") == 5000


def test_expected_minor_units_two_decimal_multiplies_by_100():
    assert expected_minor_units("50.00", "USD") == 5000


def test_refund_when_jpy_order_charged_100x():
    action, reason, overcharge = decide(jpy_order(), intent())
    assert action == "refund"
    assert overcharge == 495000  # 500000 charged - 5000 expected


def test_ok_when_jpy_order_charged_the_right_amount():
    order = jpy_order()
    charge = intent(amount_received=5000)
    assert decide(order, charge)[0] == "ok"


def test_skip_when_currency_is_not_zero_decimal():
    order = {"status": "processing", "currency": "USD", "total": "50.00"}
    assert decide(order, intent(amount_received=5000))[0] == "skip"


def test_skip_when_order_not_paid():
    order = jpy_order(status="pending")
    assert decide(order, intent())[0] == "skip"


def test_skip_when_no_intent():
    assert decide(jpy_order(), None)[0] == "skip"


def test_skip_when_intent_not_succeeded():
    action = decide(jpy_order(), intent(status="requires_payment_method"))[0]
    assert action == "skip"


def test_mismatch_when_overcharge_is_not_the_100x_pattern():
    # Charged a bit more than expected, but not anywhere near 100x.
    action, reason, overcharge = decide(jpy_order(), intent(amount_received=5100))
    assert action == "mismatch"
    assert overcharge == 0


def test_ok_when_overcharge_already_fully_refunded():
    action = decide(jpy_order(), intent(amount_refunded=495000))[0]
    assert action == "ok"


def test_refund_is_reduced_by_a_partial_prior_refund():
    action, reason, overcharge = decide(jpy_order(), intent(amount_refunded=100000))
    assert action == "refund"
    assert overcharge == 395000


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
