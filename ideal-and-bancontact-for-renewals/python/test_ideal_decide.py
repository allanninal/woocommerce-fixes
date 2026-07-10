from check_one_off_methods import decide


def intent(**over):
    base = {"payment_method_types": ["ideal"], "customer": "cus_1"}
    base.update(over)
    return base


def test_flag_when_ideal_and_no_reusable_card_and_renewal_close():
    sub = {"renewal_window_days": 7}
    assert decide(sub, intent(), False, 3)[0] == "flag"


def test_flag_when_bancontact_and_no_reusable_card_and_renewal_close():
    sub = {"renewal_window_days": 7}
    assert decide(sub, intent(payment_method_types=["bancontact"]), False, 0)[0] == "flag"


def test_ok_when_reusable_card_already_on_file():
    sub = {"renewal_window_days": 7}
    assert decide(sub, intent(), True, 3)[0] == "ok"


def test_skip_when_first_payment_was_a_card():
    sub = {"renewal_window_days": 7}
    assert decide(sub, intent(payment_method_types=["card"]), False, 3)[0] == "skip"


def test_skip_when_renewal_too_far_away():
    sub = {"renewal_window_days": 7}
    assert decide(sub, intent(), False, 20)[0] == "skip"


def test_skip_when_no_intent_found():
    sub = {"renewal_window_days": 7}
    assert decide(sub, None, False, 3)[0] == "skip"


def test_flag_uses_default_window_when_subscription_missing_it():
    sub = {}
    assert decide(sub, intent(), False, 3)[0] == "flag"


def test_flag_when_method_types_include_ideal_alongside_other_types():
    sub = {"renewal_window_days": 7}
    assert decide(sub, intent(payment_method_types=["ideal", "card"]), False, 3)[0] == "flag"
