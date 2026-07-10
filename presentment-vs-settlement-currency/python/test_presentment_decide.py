from record_settlement_currency import decide, intent_id_of, has_settlement_recorded


def balance_transaction(**over):
    base = {"amount": 4520, "currency": "usd", "exchange_rate": 0.904}
    base.update(over)
    return base


def order(**over):
    base = {"status": "processing", "total": "50.00", "currency": "eur", "meta_data": []}
    base.update(over)
    return base


def test_record_when_currencies_differ_and_rate_present():
    assert decide(order(), balance_transaction())[0] == "record"


def test_skip_when_order_not_paid():
    assert decide(order(status="pending"), balance_transaction())[0] == "skip"


def test_skip_when_already_recorded():
    o = order(meta_data=[{"key": "_stripe_settlement_amount", "value": 4520}])
    assert decide(o, balance_transaction())[0] == "skip"


def test_orphan_when_no_balance_transaction():
    assert decide(order(), None)[0] == "orphan"


def test_same_currency_when_presentment_matches_settlement():
    o = order(currency="usd")
    bt = balance_transaction(currency="usd", exchange_rate=None)
    assert decide(o, bt)[0] == "same-currency"


def test_same_currency_is_case_insensitive():
    o = order(currency="USD")
    bt = balance_transaction(currency="usd", exchange_rate=None)
    assert decide(o, bt)[0] == "same-currency"


def test_mismatch_when_currencies_differ_but_no_exchange_rate():
    o = order(currency="eur")
    bt = balance_transaction(currency="usd", exchange_rate=None)
    assert decide(o, bt)[0] == "mismatch"


def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None


def test_has_settlement_recorded_true():
    o = {"meta_data": [{"key": "_stripe_settlement_amount", "value": 100}]}
    assert has_settlement_recorded(o) is True


def test_has_settlement_recorded_false():
    o = {"meta_data": []}
    assert has_settlement_recorded(o) is False
