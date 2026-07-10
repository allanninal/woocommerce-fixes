from capture_authorized import decide


def intent(**over):
    base = {"status": "requires_capture", "amount": 5000, "id": "pi_1"}
    base.update(over)
    return base


def test_capture_when_on_hold_and_amount_matches():
    order = {"status": "on-hold", "total": "50.00"}
    assert decide(order, intent())[0] == "capture"


def test_skip_when_intent_not_awaiting_capture():
    order = {"status": "on-hold", "total": "50.00"}
    assert decide(order, intent(status="succeeded"))[0] == "skip"


def test_skip_when_order_already_processing():
    order = {"status": "processing", "total": "50.00"}
    assert decide(order, intent())[0] == "skip"


def test_mismatch_when_amount_differs():
    order = {"status": "on-hold", "total": "40.00"}
    assert decide(order, intent())[0] == "mismatch"


def test_orphan_when_order_missing():
    assert decide(None, intent())[0] == "orphan"
