from audit_refunds import decide, intent_id_of, woo_intended_refund_minor, stripe_refunded_minor


def charge(**over):
    base = {"amount_refunded": 1000}
    base.update(over)
    return base


def test_overrefund_when_stripe_returned_more_than_intended():
    order = {"id": 1, "status": "processing"}
    action, reason, gap = decide(order, charge(amount_refunded=5000), 1000, 5000)
    assert action == "overrefund"
    assert gap == 4000


def test_ok_when_amounts_match():
    order = {"id": 2, "status": "processing"}
    action, reason, gap = decide(order, charge(amount_refunded=1000), 1000, 1000)
    assert action == "ok"
    assert gap == 0


def test_ok_within_rounding_tolerance():
    order = {"id": 3, "status": "processing"}
    action, reason, gap = decide(order, charge(amount_refunded=1001), 1000, 1001)
    assert action == "ok"


def test_underrefund_when_stripe_returned_less():
    order = {"id": 4, "status": "processing"}
    action, reason, gap = decide(order, charge(amount_refunded=500), 1000, 500)
    assert action == "underrefund"


def test_orphan_when_no_charge_found():
    order = {"id": 5, "status": "processing"}
    action, reason, gap = decide(order, None, 1000, 0)
    assert action == "orphan"
    assert gap == 0


def test_skip_when_no_refund_recorded():
    order = {"id": 6, "status": "processing"}
    action, reason, gap = decide(order, charge(amount_refunded=0), 0, 0)
    assert action == "skip"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_accepts_charge_id_fallback():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) == "ch_789"


def test_intent_id_none_when_transaction_is_unrelated():
    order = {"meta_data": [], "transaction_id": "txn_other"}
    assert intent_id_of(order) is None


def test_woo_intended_refund_minor_converts_dollars_to_cents():
    order = {"total_refunded": "12.50"}
    assert woo_intended_refund_minor(order) == 1250


def test_woo_intended_refund_minor_handles_missing_value():
    order = {}
    assert woo_intended_refund_minor(order) == 0


def test_stripe_refunded_minor_reads_amount_refunded():
    assert stripe_refunded_minor(charge(amount_refunded=750)) == 750


def test_stripe_refunded_minor_handles_none_charge():
    assert stripe_refunded_minor(None) == 0
