from replay_events import extract_action


def event(t, order_id="42"):
    return {"id": "evt_1", "type": t,
            "data": {"object": {"id": "pi_1", "metadata": {"order_id": order_id}}}}


def test_complete_from_succeeded():
    assert extract_action(event("payment_intent.succeeded"))[0] == "complete"


def test_refund_from_charge_refunded():
    assert extract_action(event("charge.refunded"))[0] == "refund"


def test_none_for_unknown_type():
    assert extract_action(event("customer.created")) is None


def test_none_without_order_id():
    e = {"id": "evt_2", "type": "payment_intent.succeeded", "data": {"object": {"metadata": {}}}}
    assert extract_action(e) is None
