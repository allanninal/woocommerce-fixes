from clear_stale_card import decide


def pm(**over):
    base = {"customer": "cus_1"}
    base.update(over)
    return base


def test_ok_when_still_attached():
    assert decide("cus_1", "pm_1", pm())[0] == "ok"


def test_clear_when_payment_method_missing():
    assert decide("cus_1", "pm_1", None)[0] == "clear"


def test_clear_when_attached_to_different_customer():
    assert decide("cus_1", "pm_1", pm(customer="cus_2"))[0] == "clear"


def test_skip_when_nothing_saved():
    assert decide(None, None, None)[0] == "skip"


def test_skip_when_customer_missing_but_pm_present():
    assert decide(None, "pm_1", pm())[0] == "skip"


def test_skip_when_pm_missing_but_customer_present():
    assert decide("cus_1", None, None)[0] == "skip"
