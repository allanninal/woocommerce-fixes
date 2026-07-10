from stop_billing_on_disabled_gateway import decide, is_manual, intent_id_of


def sub(**over):
    base = {"status": "active", "payment_method": "woocommerce_payments", "requires_manual_renewal": False}
    base.update(over)
    return base


def test_repair_when_active_on_disabled_gateway():
    assert decide(sub(), ["woocommerce_payments"])[0] == "repair"


def test_repair_when_on_hold_on_disabled_gateway():
    assert decide(sub(status="on-hold"), ["woocommerce_payments"])[0] == "repair"


def test_skip_when_already_manual():
    assert decide(sub(requires_manual_renewal=True), ["woocommerce_payments"])[0] == "skip"


def test_skip_when_already_manual_string_true():
    assert decide(sub(requires_manual_renewal="true"), ["woocommerce_payments"])[0] == "skip"


def test_skip_when_gateway_not_disabled():
    assert decide(sub(payment_method="stripe"), ["woocommerce_payments"])[0] == "skip"


def test_skip_when_not_billable_status_cancelled():
    assert decide(sub(status="cancelled"), ["woocommerce_payments"])[0] == "skip"


def test_skip_when_not_billable_status_pending_cancel():
    assert decide(sub(status="pending-cancel"), ["woocommerce_payments"])[0] == "skip"


def test_skip_when_payment_method_missing():
    assert decide(sub(payment_method=""), ["woocommerce_payments"])[0] == "skip"


def test_repair_reason_includes_method_name():
    action, reason = decide(sub(), ["woocommerce_payments"])
    assert action == "repair"
    assert "woocommerce_payments" in reason


def test_is_manual_true_boolean():
    assert is_manual({"requires_manual_renewal": True}) is True


def test_is_manual_accepts_string_true():
    assert is_manual({"requires_manual_renewal": "true"}) is True


def test_is_manual_accepts_int_one():
    assert is_manual({"requires_manual_renewal": 1}) is True


def test_is_manual_false_when_missing():
    assert is_manual({}) is False


def test_is_manual_false_when_explicit_false():
    assert is_manual({"requires_manual_renewal": False}) is False


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_intent_id_none_when_order_is_none():
    assert intent_id_of(None) is None
