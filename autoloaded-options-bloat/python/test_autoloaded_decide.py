from find_stale_autoload import decide, order_id_from_option, intent_id_of


def option(**over):
    base = {"option_name": "_wc_stripe_idempotency_1042", "bytes": 20000}
    base.update(over)
    return base


def intent(**over):
    base = {"status": "succeeded"}
    base.update(over)
    return base


def test_demote_when_order_and_intent_finished():
    order = {"status": "completed"}
    assert decide(option(), order, intent())[0] == "demote"


def test_skip_when_below_size_threshold():
    order = {"status": "completed"}
    assert decide(option(bytes=500), order, intent())[0] == "skip"


def test_skip_when_option_name_not_ours():
    order = {"status": "completed"}
    result = decide(option(option_name="_transient_unrelated_thing"), order, intent())
    assert result[0] == "skip"


def test_orphan_when_order_missing():
    assert decide(option(), None, None)[0] == "orphan"


def test_keep_when_order_still_active():
    order = {"status": "pending"}
    assert decide(option(), order, intent())[0] == "keep"


def test_keep_when_intent_still_active():
    order = {"status": "processing"}
    assert decide(option(), order, intent(status="requires_action"))[0] == "keep"


def test_demote_when_intent_missing_but_order_finished():
    # The PaymentIntent may have already been cleaned up on Stripe's side (very old
    # test mode data, for example). A finished order is enough on its own.
    order = {"status": "refunded"}
    assert decide(option(), order, None)[0] == "demote"


def test_order_id_from_option_matches_digits():
    assert order_id_from_option("_wc_stripe_idempotency_1042") == 1042
    assert order_id_from_option("_wc_stripe_intent_77") == 77
    assert order_id_from_option("_wc_stripe_lock_5") == 5


def test_order_id_from_option_none_for_other_names():
    assert order_id_from_option("_transient_wc_report") is None


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
