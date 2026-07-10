from reactivate_pending_cancel import decide, intent_id_of


def order(**over):
    base = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_1"}], "transaction_id": ""}
    base.update(over)
    return base


def sub(**over):
    base = {"status": "pending-cancel", "schedule_end": "2026-08-01T00:00:00"}
    base.update(over)
    return base


def method(**over):
    base = {"status": "succeeded", "payment_method": "pm_1"}
    base.update(over)
    return base


def test_repair_when_pending_cancel_and_card_ok():
    action, _ = decide(sub(), order(), method())
    assert action == "repair"


def test_repair_even_with_no_leftover_end_date():
    action, reason = decide(sub(schedule_end=""), order(), method())
    assert action == "repair"
    assert "no leftover end date" in reason


def test_skip_when_subscription_missing():
    assert decide(None, order(), method())[0] == "skip"


def test_skip_when_status_not_reactivatable():
    assert decide(sub(status="active"), order(), method())[0] == "skip"


def test_skip_when_on_hold_is_a_separate_case():
    assert decide(sub(status="on-hold"), order(), method())[0] == "skip"


def test_blocked_when_no_saved_intent():
    action, reason = decide(sub(), order(meta_data=[], transaction_id=""), method())
    assert action == "blocked"
    assert "no saved PaymentIntent" in reason


def test_blocked_when_payment_method_missing():
    action, reason = decide(sub(), order(), None)
    assert action == "blocked"
    assert "could not read" in reason


def test_blocked_when_card_not_usable():
    action, reason = decide(sub(), order(), method(status="requires_payment_method"))
    assert action == "blocked"
    assert "not currently usable" in reason


def test_intent_id_from_meta():
    assert intent_id_of(order()) == "pi_1"


def test_intent_id_falls_back_to_transaction_id():
    assert intent_id_of({"meta_data": [], "transaction_id": "pi_456"}) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    assert intent_id_of({"meta_data": [], "transaction_id": "ch_789"}) is None


def test_intent_id_none_when_order_is_none():
    assert intent_id_of(None) is None
