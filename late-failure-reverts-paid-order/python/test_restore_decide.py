from restore_paid import decide


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000, "id": "pi_1"}
    base.update(over)
    return base


def test_restore_when_failed_but_paid():
    order = {"status": "failed", "total": "50.00"}
    assert decide(order, intent())[0] == "restore"


def test_restore_when_cancelled_but_paid():
    order = {"status": "cancelled", "total": "50.00"}
    assert decide(order, intent())[0] == "restore"


def test_skip_when_order_already_processing():
    order = {"status": "processing", "total": "50.00"}
    assert decide(order, intent())[0] == "skip"


def test_mismatch_when_amount_differs():
    order = {"status": "failed", "total": "40.00"}
    assert decide(order, intent())[0] == "mismatch"


def test_orphan_when_order_missing():
    assert decide(None, intent())[0] == "orphan"
