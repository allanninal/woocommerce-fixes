import time

from purge_checkout_drafts import decide, intent_id_of, cancelable_intent

NOW = time.time()
DAY = 24 * 3600


def draft(hours_old=48, **over):
    order = {
        "status": "checkout-draft",
        "date_modified_gmt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(NOW - hours_old * 3600)),
    }
    order.update(over)
    return order


def intent(**over):
    base = {"id": "pi_1", "status": "requires_payment_method"}
    base.update(over)
    return base


def test_purge_when_stale_and_no_payment():
    assert decide(draft(hours_old=48), None, NOW)[0] == "purge"


def test_skip_when_still_fresh():
    assert decide(draft(hours_old=1), None, NOW)[0] == "skip"


def test_skip_when_not_a_draft():
    order = draft(hours_old=48, status="pending")
    assert decide(order, None, NOW)[0] == "skip"


def test_keep_when_intent_succeeded():
    assert decide(draft(hours_old=48), intent(status="succeeded"), NOW)[0] == "keep"


def test_keep_when_intent_processing():
    assert decide(draft(hours_old=48), intent(status="processing"), NOW)[0] == "keep"


def test_purge_when_intent_still_requires_payment_method():
    action, _ = decide(draft(hours_old=48), intent(status="requires_payment_method"), NOW)
    assert action == "purge"


def test_custom_stale_after_hours():
    assert decide(draft(hours_old=10), None, NOW, stale_after_hours=5)[0] == "purge"
    assert decide(draft(hours_old=10), None, NOW, stale_after_hours=20)[0] == "skip"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_cancelable_intent_true_when_open():
    assert cancelable_intent(intent(status="requires_action")) is True


def test_cancelable_intent_false_when_succeeded():
    assert cancelable_intent(intent(status="succeeded")) is False


def test_cancelable_intent_false_when_none():
    assert cancelable_intent(None) is False
