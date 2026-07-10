from find_legacy_order_rows import decide, legacy_post_id_of, intent_id_of


def order(**over):
    base = {
        "id": 501,
        "status": "completed",
        "total": "50.00",
        "meta_data": [{"key": "_legacy_order_id", "value": "9001"}],
    }
    base.update(over)
    return base


def legacy_post(**over):
    base = {"id": 9001, "post_type": "shop_order"}
    base.update(over)
    return base


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000}
    base.update(over)
    return base


def test_report_when_settled_and_legacy_row_present():
    assert decide(order(), legacy_post(), intent())[0] == "report"


def test_report_when_no_stripe_intent_at_all():
    # Offline payment methods have no PaymentIntent to check.
    assert decide(order(), legacy_post(), None)[0] == "report"


def test_clean_when_legacy_row_already_gone():
    assert decide(order(), None, intent())[0] == "clean"


def test_skip_when_order_has_no_legacy_id():
    o = order(meta_data=[])
    assert decide(o, legacy_post(), intent())[0] == "skip"


def test_skip_when_order_still_open():
    assert decide(order(status="processing"), legacy_post(), intent())[0] == "skip"


def test_skip_when_stripe_payment_still_in_progress():
    assert decide(order(), legacy_post(), intent(status="requires_action"))[0] == "skip"


def test_skip_when_post_id_was_reused_by_other_content():
    assert decide(order(), legacy_post(post_type="page"), intent())[0] == "skip"


def test_mismatch_when_amount_disagrees():
    assert decide(order(total="80.00"), legacy_post(), intent())[0] == "mismatch"


def test_legacy_post_id_of_reads_meta():
    assert legacy_post_id_of(order()) == 9001


def test_legacy_post_id_of_none_when_missing():
    assert legacy_post_id_of(order(meta_data=[])) is None


def test_intent_id_from_meta():
    o = order(meta_data=[{"key": "_stripe_intent_id", "value": "pi_123"}])
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = order(meta_data=[], transaction_id="pi_456")
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = order(meta_data=[], transaction_id="ch_789")
    assert intent_id_of(o) is None
