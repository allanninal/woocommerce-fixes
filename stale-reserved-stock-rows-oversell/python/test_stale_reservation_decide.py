from release_stale_reservations import decide, intent_id_of


def intent(**over):
    base = {"status": "succeeded"}
    base.update(over)
    return base


def test_release_when_stale_and_unpaid():
    order = {"status": "pending"}
    assert decide(order, None, age_minutes=90, hold_minutes=60)[0] == "release"


def test_release_when_stale_and_intent_never_succeeded():
    order = {"status": "pending"}
    action = decide(order, intent(status="requires_payment_method"), age_minutes=90, hold_minutes=60)[0]
    assert action == "release"


def test_skip_when_still_within_hold_window():
    order = {"status": "pending"}
    assert decide(order, None, age_minutes=10, hold_minutes=60)[0] == "skip"


def test_skip_when_order_not_in_holding_status():
    order = {"status": "processing"}
    assert decide(order, None, age_minutes=200, hold_minutes=60)[0] == "skip"


def test_paid_when_stripe_shows_succeeded():
    order = {"status": "pending"}
    assert decide(order, intent(), age_minutes=90, hold_minutes=60)[0] == "paid"


def test_checkout_draft_is_also_a_holding_status():
    order = {"status": "checkout-draft"}
    assert decide(order, None, age_minutes=90, hold_minutes=60)[0] == "release"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
