from resolve_3ds import classify


def test_complete_when_succeeded():
    assert classify("succeeded", 0.1, 6) == "complete"


def test_fail_when_old_and_waiting():
    assert classify("requires_action", 8, 6) == "fail"


def test_wait_when_recent_and_waiting():
    assert classify("requires_action", 1, 6) == "wait"


def test_wait_for_unknown_status():
    assert classify("canceled", 100, 6) == "wait"
