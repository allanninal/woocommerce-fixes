from dedupe_webhook_events import decide, next_ledger, ledger_of, intent_id_of


def event(**over):
    base = {"id": "evt_1", "type": "payment_intent.succeeded",
            "data": {"object": {"metadata": {"order_id": "42"}}}}
    base.update(over)
    return base


def test_apply_when_event_is_new():
    order = {"id": 42, "status": "processing"}
    assert decide(order, event(), [])[0] == "apply"


def test_skip_when_event_id_already_in_ledger():
    order = {"id": 42, "status": "processing"}
    assert decide(order, event(), ["evt_1"])[0] == "skip"


def test_apply_when_ledger_has_other_ids():
    order = {"id": 42, "status": "processing"}
    assert decide(order, event(), ["evt_0", "evt_9"])[0] == "apply"


def test_ignore_when_event_type_not_handled():
    order = {"id": 42, "status": "processing"}
    assert decide(order, event(type="charge.refunded"), [])[0] == "ignore"


def test_orphan_when_order_missing():
    assert decide(None, event(), [])[0] == "orphan"


def test_next_ledger_appends_event_id():
    assert next_ledger(["evt_1"], "evt_2") == ["evt_1", "evt_2"]


def test_next_ledger_caps_size():
    ledger = [f"evt_{i}" for i in range(50)]
    result = next_ledger(ledger, "evt_50")
    assert len(result) == 50
    assert result[0] == "evt_1"
    assert result[-1] == "evt_50"


def test_ledger_of_reads_meta_data():
    order = {"meta_data": [{"key": "_processed_webhook_event_ids", "value": ["evt_1", "evt_2"]}]}
    assert ledger_of(order) == ["evt_1", "evt_2"]


def test_ledger_of_empty_when_no_meta():
    assert ledger_of({"meta_data": []}) == []


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"
