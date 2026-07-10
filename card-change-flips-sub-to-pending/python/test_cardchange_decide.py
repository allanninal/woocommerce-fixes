from resume_pending_after_card_change import decide, intent_id_of, current_card_token, get_meta


def intent(**over):
    base = {"status": "succeeded", "payment_method": "pm_new"}
    base.update(over)
    return base


def test_resume_when_succeeded_and_card_matches():
    assert decide("pending", intent(), "pm_new")[0] == "resume"


def test_wait_when_no_intent_yet():
    assert decide("pending", None, "pm_new")[0] == "wait"


def test_wait_when_intent_not_succeeded():
    assert decide("pending", intent(status="requires_action"), "pm_new")[0] == "wait"


def test_mismatch_when_card_differs():
    assert decide("pending", intent(), "pm_old")[0] == "mismatch"


def test_mismatch_when_no_card_to_compare():
    assert decide("pending", intent(), None)[0] == "mismatch"


def test_skip_when_not_pending():
    assert decide("active", intent(), "pm_new")[0] == "skip"


def test_skip_takes_priority_over_missing_intent():
    assert decide("on-hold", None, "pm_new")[0] == "skip"


def test_intent_id_from_meta():
    sub = {"meta_data": [{"key": "_stripe_intent_id", "value": "seti_123"}], "transaction_id": ""}
    assert intent_id_of(sub) == "seti_123"


def test_intent_id_falls_back_to_transaction_id():
    sub = {"meta_data": [], "transaction_id": "seti_456"}
    assert intent_id_of(sub) == "seti_456"


def test_intent_id_none_when_transaction_is_not_a_setup_intent():
    sub = {"meta_data": [], "transaction_id": "pi_789"}
    assert intent_id_of(sub) is None


def test_current_card_token_prefers_source_id():
    sub = {"meta_data": [
        {"key": "_stripe_source_id", "value": "pm_source"},
        {"key": "_payment_method_token", "value": "pm_token"},
    ]}
    assert current_card_token(sub) == "pm_source"


def test_current_card_token_falls_back_to_payment_method_token():
    sub = {"meta_data": [{"key": "_payment_method_token", "value": "pm_token"}]}
    assert current_card_token(sub) == "pm_token"


def test_get_meta_missing_key_returns_none():
    assert get_meta({"meta_data": []}, "_stripe_intent_id") is None
