from recount_terms import decide


def test_skip_when_count_already_correct():
    assert decide({"count": 42}, 42)[0] == "skip"


def test_repair_when_count_too_high():
    assert decide({"count": 42}, 31)[0] == "repair"


def test_repair_when_count_too_low():
    assert decide({"count": 5}, 12)[0] == "repair"


def test_skip_when_real_is_negative():
    assert decide({"count": 5}, -1)[0] == "skip"


def test_defaults_stored_count_to_zero():
    action, reason = decide({}, 3)
    assert action == "repair"
    assert "stored 0" in reason


def test_repair_reason_includes_both_numbers():
    action, reason = decide({"count": 10}, 4)
    assert action == "repair"
    assert "stored 10" in reason
    assert "real 4" in reason


def test_zero_is_a_valid_real_count():
    assert decide({"count": 3}, 0)[0] == "repair"
    assert decide({"count": 0}, 0)[0] == "skip"
