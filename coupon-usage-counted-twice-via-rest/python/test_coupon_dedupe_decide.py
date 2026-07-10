from coupon_usage_dedupe import decide, counts_as_one_real_use, intent_id_of


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000}
    base.update(over)
    return base


def coupon(**over):
    base = {"id": 42, "code": "SAVE10", "usage_count": 2}
    base.update(over)
    return base


def order(**over):
    base = {"id": 900, "status": "processing", "total": "50.00"}
    base.update(over)
    return base


# decide()

def test_fix_when_usage_count_is_inflated():
    action, reason, corrected = decide(coupon(usage_count=2), 1)
    assert action == "fix"
    assert corrected == 1


def test_skip_when_usage_count_matches_verified_orders():
    action, reason, corrected = decide(coupon(usage_count=1), 1)
    assert action == "skip"


def test_skip_when_verified_count_exceeds_usage_count():
    # Undercounting is a different bug, this script does not touch it.
    action, reason, corrected = decide(coupon(usage_count=1), 2)
    assert action == "skip"


def test_skip_when_usage_count_already_negative():
    action, reason, corrected = decide(coupon(usage_count=-1), 0)
    assert action == "skip"


def test_fix_reason_mentions_both_numbers():
    action, reason, corrected = decide(coupon(usage_count=3), 1)
    assert "3" in reason and "1" in reason


# counts_as_one_real_use()

def test_counts_when_status_valid_and_stripe_confirms_paid():
    assert counts_as_one_real_use(order(), intent()) is True


def test_does_not_count_when_order_status_not_valid():
    assert counts_as_one_real_use(order(status="pending"), intent()) is False


def test_does_not_count_when_intent_missing():
    assert counts_as_one_real_use(order(), None) is False


def test_does_not_count_when_intent_not_succeeded():
    bad_intent = intent(status="requires_payment_method")
    assert counts_as_one_real_use(order(), bad_intent) is False


def test_does_not_count_when_amount_mismatches():
    mismatched_intent = intent(amount_received=1000)
    assert counts_as_one_real_use(order(total="50.00"), mismatched_intent) is False


def test_counts_with_on_hold_status():
    assert counts_as_one_real_use(order(status="on-hold"), intent()) is True


# intent_id_of()

def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None
