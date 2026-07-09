from reconcile_pending import decide


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000, "id": "pi_1"}
    base.update(over)
    return base


def test_fix_when_pending_and_paid():
    order = {"status": "pending", "total": "50.00"}
    assert decide(order, intent())[0] == "fix"


def test_skip_when_already_processing():
    order = {"status": "processing", "total": "50.00"}
    assert decide(order, intent())[0] == "skip"


def test_mismatch_when_amount_differs():
    order = {"status": "pending", "total": "40.00"}
    assert decide(order, intent())[0] == "mismatch"


def test_orphan_when_order_missing():
    assert decide(None, intent())[0] == "orphan"
