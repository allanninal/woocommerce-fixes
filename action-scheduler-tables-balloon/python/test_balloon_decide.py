from audit_action_scheduler import decide, intent_id_of


def group(**over):
    base = {"status": "complete", "age_days": 45, "row_count": 1}
    base.update(over)
    return base


def order(**over):
    base = {"status": "completed"}
    base.update(over)
    return base


def intent(**over):
    base = {"status": "succeeded"}
    base.update(over)
    return base


def test_keep_when_action_still_pending():
    assert decide(group(status="pending"), order(), intent())[0] == "keep"


def test_keep_when_younger_than_retention_window():
    assert decide(group(age_days=5), order(), intent())[0] == "keep"


def test_purge_when_no_matching_order():
    assert decide(group(), None, None)[0] == "purge"


def test_warn_when_order_still_open():
    assert decide(group(), order(status="processing"), intent())[0] == "warn"


def test_purge_when_order_closed_and_no_stripe_intent():
    assert decide(group(), order(status="cancelled"), None)[0] == "purge"


def test_warn_when_intent_not_closed():
    assert decide(group(), order(), intent(status="requires_payment_method"))[0] == "warn"


def test_purge_when_order_closed_and_intent_succeeded():
    assert decide(group(), order(), intent(status="succeeded"))[0] == "purge"


def test_purge_when_intent_canceled_counts_as_closed():
    assert decide(group(), order(), intent(status="canceled"))[0] == "purge"


def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None
