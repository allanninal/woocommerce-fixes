from run_due_renewals import decide, intent_id_of, order_amount_minor

NOW = 1_800_000_000  # a fixed "now" for deterministic tests
HOUR = 3600
DAY = 24 * HOUR


def sub(**over):
    base = {
        "status": "active",
        "next_payment_ts": NOW - 5 * HOUR,
        "last_order_status": "pending",
        "payment_method_token": "pm_123",
    }
    base.update(over)
    return base


def test_charge_when_past_due_and_past_grace():
    assert decide(sub(), NOW)[0] == "charge"


def test_wait_when_inside_grace_window():
    s = sub(next_payment_ts=NOW - 1 * HOUR)
    assert decide(s, NOW)[0] == "wait"


def test_skip_when_not_due_yet():
    s = sub(next_payment_ts=NOW + 1 * HOUR)
    assert decide(s, NOW)[0] == "skip"


def test_skip_when_subscription_not_active():
    s = sub(status="cancelled")
    assert decide(s, NOW)[0] == "skip"


def test_skip_when_no_renewal_scheduled():
    s = sub(next_payment_ts=None)
    assert decide(s, NOW)[0] == "skip"


def test_skip_when_renewal_already_paid():
    s = sub(last_order_status="processing")
    assert decide(s, NOW)[0] == "skip"


def test_blocked_when_no_payment_method():
    s = sub(payment_method_token=None)
    assert decide(s, NOW)[0] == "blocked"


def test_stale_when_overdue_past_stale_window():
    s = sub(next_payment_ts=NOW - 20 * DAY)
    assert decide(s, NOW)[0] == "stale"


def test_grace_and_stale_windows_are_configurable():
    s = sub(next_payment_ts=NOW - 2 * HOUR)
    assert decide(s, NOW, grace_hours=1, stale_days=14)[0] == "charge"
    assert decide(s, NOW, grace_hours=6, stale_days=14)[0] == "wait"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_order_amount_minor_converts_to_cents():
    assert order_amount_minor({"total": "49.99"}) == 4999
