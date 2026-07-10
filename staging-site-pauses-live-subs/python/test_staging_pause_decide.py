from restore_wrongly_paused_subs import decide, paused_by_host, intent_id_of

LIVE_HOST = "shop.example.com"


def sub(**over):
    base = {
        "status": "on-hold",
        "meta_data": [{"key": "_paused_by_host", "value": "staging.example.com"}],
    }
    base.update(over)
    return base


def invoice(**over):
    base = {"status": "paid"}
    base.update(over)
    return base


def test_restore_when_paused_by_staging_and_invoice_paid():
    assert decide(sub(), invoice(), LIVE_HOST)[0] == "restore"


def test_skip_when_not_on_hold():
    assert decide(sub(status="active"), invoice(), LIVE_HOST)[0] == "skip"


def test_skip_when_no_host_recorded():
    s = sub(meta_data=[])
    assert decide(s, invoice(), LIVE_HOST)[0] == "skip"


def test_skip_when_paused_by_the_live_site():
    s = sub(meta_data=[{"key": "_paused_by_host", "value": LIVE_HOST}])
    assert decide(s, invoice(), LIVE_HOST)[0] == "skip"


def test_hold_when_no_invoice_found():
    assert decide(sub(), None, LIVE_HOST)[0] == "hold"


def test_hold_when_invoice_not_paid():
    assert decide(sub(), invoice(status="open"), LIVE_HOST)[0] == "hold"


def test_paused_by_host_reads_meta():
    assert paused_by_host(sub()) == "staging.example.com"


def test_paused_by_host_missing_is_none():
    assert paused_by_host({"meta_data": []}) is None


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
