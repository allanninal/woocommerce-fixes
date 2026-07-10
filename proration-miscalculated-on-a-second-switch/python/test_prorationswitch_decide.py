from detect_switch_proration import decide, expected_proration_minor, to_minor, intent_id_of


def cycle(**over):
    base = {"days_remaining": 15, "days_in_cycle": 30, "old_price_minor": 4000, "new_price_minor": 6000}
    base.update(over)
    return base


def test_ok_when_order_matches_expected_and_stripe():
    c = cycle()
    expected = expected_proration_minor(c["days_remaining"], c["days_in_cycle"], c["old_price_minor"], c["new_price_minor"])
    order = {"total": f"{expected / 100:.2f}"}
    assert decide(order, 0, c, expected)[0] == "ok"


def test_flag_when_order_total_uses_wrong_baseline():
    c = cycle()
    # Bug: order was prorated against the original $20 plan instead of the $40
    # plan the first switch already set, so it charges too much.
    wrong_baseline_minor = 2000
    wrong_total = expected_proration_minor(c["days_remaining"], c["days_in_cycle"], wrong_baseline_minor, c["new_price_minor"])
    order = {"total": f"{wrong_total / 100:.2f}"}
    assert decide(order, 0, c, wrong_total)[0] == "flag"


def test_flag_when_stripe_amount_disagrees_with_order_total():
    c = cycle()
    expected = expected_proration_minor(c["days_remaining"], c["days_in_cycle"], c["old_price_minor"], c["new_price_minor"])
    order = {"total": f"{expected / 100:.2f}"}
    assert decide(order, 0, c, expected + 500)[0] == "flag"


def test_ok_when_no_stripe_charge_and_order_matches_a_pure_credit():
    c = cycle(old_price_minor=6000, new_price_minor=4000)
    expected = expected_proration_minor(c["days_remaining"], c["days_in_cycle"], c["old_price_minor"], c["new_price_minor"])
    order = {"total": f"{expected / 100:.2f}"}
    assert decide(order, 0, c, None)[0] == "ok"


def test_expected_proration_is_zero_when_days_in_cycle_is_zero():
    assert expected_proration_minor(10, 0, 1000, 2000) == 0


def test_expected_proration_matches_hand_calculation():
    # $40 to $60 plan, 15 of 30 days left: (6000-4000)/30 * 15 = 1000 cents.
    assert expected_proration_minor(15, 30, 4000, 6000) == 1000


def test_to_minor_handles_typical_price_strings():
    assert to_minor("19.99") == 1999
    assert to_minor("0.00") == 0


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
