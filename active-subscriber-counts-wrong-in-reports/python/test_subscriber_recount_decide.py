from recount_active_subscribers import (
    is_real_subscriber,
    recount,
    decide,
    intent_id_of,
    stripe_status_agrees,
)


def sub(**over):
    base = {"status": "active"}
    base.update(over)
    return base


def test_active_status_counts():
    assert is_real_subscriber(sub(status="active")) is True


def test_pending_cancel_still_counts():
    assert is_real_subscriber(sub(status="pending-cancel")) is True


def test_cancelled_does_not_count():
    assert is_real_subscriber(sub(status="cancelled")) is False


def test_on_hold_does_not_count():
    assert is_real_subscriber(sub(status="on-hold")) is False


def test_trial_not_converted_does_not_count():
    assert is_real_subscriber(sub(status="active", trial_end=1000, has_converted_from_trial=False)) is False


def test_trial_converted_counts():
    assert is_real_subscriber(sub(status="active", trial_end=1000, has_converted_from_trial=True)) is True


def test_past_end_date_does_not_count():
    assert is_real_subscriber(sub(status="active", end_date=100, _now=200)) is False


def test_recount_counts_only_real_subscribers():
    subs = [
        sub(status="active"),
        sub(status="pending-cancel"),
        sub(status="cancelled"),
        sub(status="on-hold"),
        sub(status="active"),
    ]
    assert recount(subs) == 3


def test_decide_ok_when_counts_match():
    action, reason, diff = decide(10, 10)
    assert action == "ok"
    assert diff == 0


def test_decide_small_drift_is_auto_repairable():
    action, reason, diff = decide(10, 11)
    assert action == "drift"
    assert diff == 1


def test_decide_large_drift_needs_review():
    action, reason, diff = decide(10, 25)
    assert action == "drift-large"
    assert diff == 15


def test_decide_handles_cached_over_count_too():
    action, reason, diff = decide(50, 30)
    assert action == "drift-large"
    assert diff == -20


def test_intent_id_from_meta():
    subscription = {"meta_data": [{"key": "_stripe_subscription_id", "value": "sub_123"}], "transaction_id": ""}
    assert intent_id_of(subscription) == "sub_123"


def test_intent_id_falls_back_to_transaction_id():
    subscription = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(subscription) == "pi_456"


def test_intent_id_none_when_transaction_is_unrelated():
    subscription = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(subscription) is None


def test_stripe_status_agrees_when_both_active():
    assert stripe_status_agrees(sub(status="active"), {"status": "active"}) is True


def test_stripe_status_disagrees_when_stripe_cancelled():
    assert stripe_status_agrees(sub(status="active"), {"status": "canceled"}) is False


def test_stripe_status_agrees_none_when_no_stripe_object():
    assert stripe_status_agrees(sub(status="active"), None) is None
