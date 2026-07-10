from match_delayed_payments import decide, order_amount_minor


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000, "currency": "usd", "id": "pi_1"}
    base.update(over)
    return base


def order(**over):
    base = {"status": "pending", "total": "50.00", "currency": "USD"}
    base.update(over)
    return base


def test_fix_when_pending_and_delayed_method_succeeded():
    assert decide(order(), intent())[0] == "fix"


def test_skip_when_already_processing():
    assert decide(order(status="processing"), intent())[0] == "skip"


def test_skip_when_already_completed():
    assert decide(order(status="completed"), intent())[0] == "skip"


def test_skip_when_order_cancelled():
    assert decide(order(status="cancelled"), intent())[0] == "skip"


def test_skip_when_order_refunded():
    assert decide(order(status="refunded"), intent())[0] == "skip"


def test_mismatch_when_amount_differs():
    assert decide(order(total="40.00"), intent())[0] == "mismatch"


def test_mismatch_when_currency_differs():
    assert decide(order(currency="EUR"), intent())[0] == "mismatch"


def test_orphan_when_order_missing():
    assert decide(None, intent())[0] == "orphan"


def test_skip_when_intent_not_yet_succeeded():
    assert decide(order(), intent(status="processing"))[0] == "skip"


def test_amount_within_one_cent_rounding_still_fixes():
    # 49.995 rounds to 4999 or 5000 depending on float noise; allow a 1 cent tolerance.
    assert decide(order(total="49.99"), intent(amount_received=4999))[0] == "fix"


def test_order_amount_minor_converts_dollars_to_cents():
    assert order_amount_minor({"total": "19.99"}) == 1999
