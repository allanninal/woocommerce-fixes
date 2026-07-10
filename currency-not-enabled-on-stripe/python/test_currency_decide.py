from detect_currency_not_enabled import decide, intent_id_of, order_currency


ENABLED = {"usd", "eur", "gbp"}


def intent(**over):
    base = {"last_payment_error": None}
    base.update(over)
    return base


def test_flag_when_currency_not_enabled():
    order = {"status": "pending", "currency": "SEK"}
    action, reason = decide(order, ENABLED, intent())
    assert action == "flag"
    assert "sek" in reason


def test_skip_when_currency_enabled_and_no_intent():
    order = {"status": "pending", "currency": "USD"}
    assert decide(order, ENABLED, None)[0] == "skip"


def test_flag_when_stripe_reports_currency_not_enabled_error():
    order = {"status": "failed", "currency": "EUR"}
    bad_intent = intent(last_payment_error={"code": "currency_not_enabled"})
    action, reason = decide(order, ENABLED, bad_intent)
    assert action == "flag"
    assert "currency_not_enabled" in reason


def test_skip_when_order_not_in_checkable_status():
    order = {"status": "processing", "currency": "SEK"}
    assert decide(order, ENABLED, None)[0] == "skip"


def test_skip_when_order_has_no_currency():
    order = {"status": "pending", "currency": ""}
    assert decide(order, ENABLED, None)[0] == "skip"


def test_skip_when_currency_enabled_and_unrelated_error():
    order = {"status": "failed", "currency": "USD"}
    bad_intent = intent(last_payment_error={"code": "card_declined"})
    assert decide(order, ENABLED, bad_intent)[0] == "skip"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_order_currency_lower_cases():
    assert order_currency({"currency": "USD"}) == "usd"
