from find_duplicate_intents import find_candidate_duplicates, intent_id_of, order_amount_minor


def intent(**over):
    base = {"id": "pi_primary", "status": "succeeded", "amount_received": 5000, "created": 1_700_000_000}
    base.update(over)
    return base


def test_finds_duplicate_same_amount_same_window():
    primary = intent()
    other = intent(id="pi_retry", created=1_700_000_120)
    result = find_candidate_duplicates(primary, [other], 5000, window_seconds=1800)
    assert len(result) == 1
    assert result[0][0]["id"] == "pi_retry"


def test_ignores_itself():
    primary = intent()
    result = find_candidate_duplicates(primary, [intent()], 5000, window_seconds=1800)
    assert result == []


def test_ignores_non_succeeded_candidates():
    primary = intent()
    other = intent(id="pi_failed", status="requires_payment_method", created=1_700_000_60)
    result = find_candidate_duplicates(primary, [other], 5000, window_seconds=1800)
    assert result == []


def test_ignores_different_amount():
    primary = intent()
    other = intent(id="pi_other_amount", amount_received=1500, created=1_700_000_60)
    result = find_candidate_duplicates(primary, [other], 5000, window_seconds=1800)
    assert result == []


def test_ignores_outside_time_window():
    primary = intent()
    other = intent(id="pi_far_away", created=1_700_000_000 + 7200)
    result = find_candidate_duplicates(primary, [other], 5000, window_seconds=1800)
    assert result == []


def test_no_duplicates_when_primary_not_succeeded():
    primary = intent(status="requires_payment_method")
    other = intent(id="pi_retry", created=1_700_000_120)
    result = find_candidate_duplicates(primary, [other], 5000, window_seconds=1800)
    assert result == []


def test_no_duplicates_when_primary_missing():
    result = find_candidate_duplicates(None, [intent()], 5000, window_seconds=1800)
    assert result == []


def test_multiple_duplicates_are_all_returned():
    primary = intent()
    others = [intent(id="pi_retry_1", created=1_700_000_060), intent(id="pi_retry_2", created=1_700_000_090)]
    result = find_candidate_duplicates(primary, others, 5000, window_seconds=1800)
    ids = sorted(d["id"] for d, _reason in result)
    assert ids == ["pi_retry_1", "pi_retry_2"]


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
    assert order_amount_minor({"total": "50.00"}) == 5000
