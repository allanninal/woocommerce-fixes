from repoint_sub_card import needs_repoint


def test_repoint_when_different():
    assert needs_repoint("pm_old", "pm_new") is True


def test_skip_when_same():
    assert needs_repoint("pm_same", "pm_same") is False


def test_skip_when_no_default():
    assert needs_repoint("pm_old", None) is False


def test_repoint_when_none_stored():
    assert needs_repoint(None, "pm_new") is True
