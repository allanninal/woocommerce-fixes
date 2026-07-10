from resume_dunning import decide, intent_id_of, dunning_attempt_count, hours_since_last_attempt

NOW = 1_800_000_000  # any fixed reference point, only relative hours matter
DAY = 86400


def sub(**over):
    base = {
        "status": "on-hold",
        "meta_data": [
            {"key": "_dunning_attempt_count", "value": "1"},
            {"key": "_dunning_last_attempt_ts", "value": str(NOW - 2 * DAY)},
        ],
    }
    base.update(over)
    return base


def order(**over):
    base = {"status": "on-hold", "total": "50.00"}
    base.update(over)
    return base


def test_resume_when_stalled_with_attempts_left():
    assert decide(sub(), order(), NOW)[0] == "resume"


def test_wait_when_inside_the_normal_window():
    recent = sub(meta_data=[
        {"key": "_dunning_attempt_count", "value": "1"},
        {"key": "_dunning_last_attempt_ts", "value": str(NOW - 3600)},
    ])
    assert decide(recent, order(), NOW)[0] == "wait"


def test_exhausted_when_every_attempt_ran():
    maxed = sub(meta_data=[
        {"key": "_dunning_attempt_count", "value": "3"},
        {"key": "_dunning_last_attempt_ts", "value": str(NOW - 5 * DAY)},
    ])
    assert decide(maxed, order(), NOW)[0] == "exhausted"


def test_skip_when_subscription_not_on_hold():
    active = sub(status="active")
    assert decide(active, order(), NOW)[0] == "skip"


def test_skip_when_no_renewal_order():
    assert decide(sub(), None, NOW)[0] == "skip"


def test_resume_when_never_recorded_before():
    fresh = sub(meta_data=[])
    assert decide(fresh, order(), NOW)[0] == "resume"


def test_dunning_attempt_count_reads_meta():
    assert dunning_attempt_count(sub()) == 1


def test_dunning_attempt_count_defaults_to_zero():
    assert dunning_attempt_count(sub(meta_data=[])) == 0


def test_hours_since_last_attempt_computes_delta():
    hours = hours_since_last_attempt(sub(), NOW)
    assert 47.9 < hours < 48.1


def test_hours_since_last_attempt_none_when_missing():
    assert hours_since_last_attempt(sub(meta_data=[]), NOW) is None


def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None
