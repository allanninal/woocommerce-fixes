from record_disputes import decide, order_dispute_meta, dispute_amount_minor, intent_id_of_dispute


def dispute(**over):
    base = {
        "id": "dp_1",
        "status": "warning_needs_response",
        "amount": 5000,
        "currency": "usd",
        "reason": "fraudulent",
        "evidence_details": {"due_by": 1_800_000_000},
    }
    base.update(over)
    return base


def test_record_when_never_recorded():
    order = {"id": 10, "status": "processing", "meta_data": []}
    assert decide(order, dispute())[0] == "record"


def test_skip_when_status_unchanged():
    order = {
        "id": 10,
        "status": "processing",
        "meta_data": [{"key": "_dispute_status", "value": "warning_needs_response"}],
    }
    assert decide(order, dispute())[0] == "skip"


def test_record_when_status_moved_on():
    order = {
        "id": 10,
        "status": "processing",
        "meta_data": [{"key": "_dispute_status", "value": "warning_needs_response"}],
    }
    assert decide(order, dispute(status="lost"))[0] == "record"


def test_orphan_when_order_missing():
    action, reason = decide(None, dispute())
    assert action == "orphan"
    assert "no order" in reason


def test_order_dispute_meta_reads_existing_value():
    order = {"meta_data": [{"key": "_dispute_status", "value": "won"}]}
    assert order_dispute_meta(order) == "won"


def test_order_dispute_meta_none_when_absent():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_1"}]}
    assert order_dispute_meta(order) is None


def test_dispute_amount_minor_is_already_cents():
    assert dispute_amount_minor(dispute(amount=12345)) == 12345


def test_intent_id_of_dispute_from_expanded_charge():
    d = dispute(charge={"payment_intent": "pi_abc"})
    assert intent_id_of_dispute(d) == "pi_abc"


def test_intent_id_of_dispute_none_when_charge_missing():
    d = dispute(charge=None)
    assert intent_id_of_dispute(d) is None
