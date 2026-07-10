from detect_key_mixup import (
    decide,
    key_mode,
    gateway_test_mode,
    mode_mismatch_from_error,
    intent_id_of,
)


LIVE_MODE_ERROR = (
    "No such payment_intent: 'pi_123'; a similar object exists in live mode, "
    "but a test mode key was used to make this request."
)
TEST_MODE_ERROR = (
    "No such payment_intent: 'pi_456'; a similar object exists in test mode, "
    "but a live mode key was used to make this request."
)


def test_key_mode_detects_test_secret_key():
    assert key_mode("sk_test_abc123") == "test"


def test_key_mode_detects_live_secret_key():
    assert key_mode("sk_live_abc123") == "live"


def test_key_mode_detects_restricted_keys():
    assert key_mode("rk_test_abc123") == "test"
    assert key_mode("rk_live_abc123") == "live"


def test_key_mode_unknown_for_garbage():
    assert key_mode("not-a-real-key") == "unknown"
    assert key_mode(None) == "unknown"


def test_gateway_test_mode_true_when_yes():
    assert gateway_test_mode({"testmode": {"value": "yes"}}) is True


def test_gateway_test_mode_false_when_no():
    assert gateway_test_mode({"testmode": {"value": "no"}}) is False


def test_gateway_test_mode_false_when_missing():
    assert gateway_test_mode({}) is False
    assert gateway_test_mode(None) is False


def test_mode_mismatch_from_error_live():
    assert mode_mismatch_from_error(LIVE_MODE_ERROR) == "live"


def test_mode_mismatch_from_error_test():
    assert mode_mismatch_from_error(TEST_MODE_ERROR) == "test"


def test_mode_mismatch_from_error_none_for_unrelated_message():
    assert mode_mismatch_from_error("No such payment_intent: 'pi_999'") is None


def test_mode_mismatch_from_error_none_for_empty():
    assert mode_mismatch_from_error(None) is None
    assert mode_mismatch_from_error("") is None


def test_decide_match_when_key_and_store_agree():
    verdict, _ = decide("live", store_test_mode=False)
    assert verdict == "match"


def test_decide_match_in_test_mode_too():
    verdict, _ = decide("test", store_test_mode=True)
    assert verdict == "match"


def test_decide_config_drift_when_live_key_but_store_says_test():
    verdict, reason = decide("live", store_test_mode=True)
    assert verdict == "config_drift"
    assert "test mode" in reason


def test_decide_config_drift_when_test_key_but_store_says_live():
    verdict, reason = decide("test", store_test_mode=False)
    assert verdict == "config_drift"
    assert "live mode" in reason


def test_decide_inconclusive_when_key_mode_unknown():
    verdict, _ = decide("unknown", store_test_mode=False)
    assert verdict == "inconclusive"


def test_decide_confirmed_mismatch_overrides_matching_config():
    # Even if the gateway setting agrees with our key, a live probe error wins,
    # because the probe is stronger evidence than a checkbox in the settings.
    verdict, reason = decide("live", store_test_mode=False, probe_error_message=LIVE_MODE_ERROR)
    assert verdict == "confirmed_mismatch"
    assert "live mode" in reason


def test_decide_confirmed_mismatch_test_key_against_live_object():
    verdict, reason = decide("test", store_test_mode=True, probe_error_message=TEST_MODE_ERROR)
    assert verdict == "confirmed_mismatch"
    assert "test mode" in reason


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
