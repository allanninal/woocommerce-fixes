from purge_auto_drafts import decide, intent_id_of, age_hours

NOW = 1_800_000_000  # fixed reference time so age math is deterministic


def order(**over):
    base = {
        "status": "auto-draft",
        "date_created_gmt": "2026-07-08T00:00:00",
    }
    base.update(over)
    return base


def intent(**over):
    base = {"status": "succeeded"}
    base.update(over)
    return base


def test_skip_when_not_a_draft_status():
    o = order(status="pending")
    assert decide(o, None, now=NOW)[0] == "skip"


def test_keep_when_intent_is_in_progress():
    o = order()
    i = intent(status="requires_action")
    assert decide(o, i, now=NOW)[0] == "keep"


def test_keep_when_intent_already_succeeded():
    o = order()
    i = intent(status="succeeded")
    assert decide(o, i, now=NOW)[0] == "keep"


def test_keep_when_draft_is_young():
    o = {"status": "auto-draft", "date_created_gmt": "2026-07-09T23:00:00"}
    now = age_reference("2026-07-10T00:00:00")
    assert decide(o, None, now=now, max_age_hours=24)[0] == "keep"


def test_delete_when_stale_and_no_intent():
    o = {"status": "auto-draft", "date_created_gmt": "2026-07-01T00:00:00"}
    now = age_reference("2026-07-10T00:00:00")
    assert decide(o, None, now=now, max_age_hours=24)[0] == "delete"


def test_delete_when_stale_and_intent_abandoned():
    o = {"status": "checkout-draft", "date_created_gmt": "2026-07-01T00:00:00"}
    now = age_reference("2026-07-10T00:00:00")
    i = intent(status="canceled")
    assert decide(o, i, now=now, max_age_hours=24)[0] == "delete"


def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None


def test_age_hours_computed_from_created_date():
    o = {"date_created_gmt": "2026-07-09T00:00:00"}
    now = age_reference("2026-07-10T00:00:00")
    assert abs(age_hours(o, now) - 24.0) < 0.01


def age_reference(iso_string):
    import datetime
    dt = datetime.datetime.fromisoformat(iso_string)
    return dt.replace(tzinfo=datetime.timezone.utc).timestamp()
