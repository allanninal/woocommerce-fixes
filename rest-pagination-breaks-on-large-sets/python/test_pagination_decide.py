from paginate_orders import decide, decide_batch, intent_id_of, order_amount_minor


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000, "id": "pi_1"}
    base.update(over)
    return base


def order(**over):
    base = {"id": 100, "status": "pending", "total": "50.00"}
    base.update(over)
    return base


# decide_batch: the stable-sort walk itself


def test_first_page_has_no_repeats():
    batch = [order(id=1), order(id=2), order(id=3)]
    result = decide_batch(batch, None)
    assert [o["id"] for o in result["new_orders"]] == [1, 2, 3]
    assert result["repeats"] == 0
    assert result["next_floor"] == 3


def test_next_page_only_keeps_ids_above_the_floor():
    batch = [order(id=3), order(id=4), order(id=5)]
    result = decide_batch(batch, 3)
    assert [o["id"] for o in result["new_orders"]] == [4, 5]
    assert result["repeats"] == 1
    assert result["next_floor"] == 5


def test_a_row_that_shifted_back_a_page_is_dropped_as_a_repeat_not_lost():
    # simulates a row moving from page 2 into page 1 mid-scan: it still
    # shows up at or below the floor, so it is skipped here because it
    # was already yielded on the earlier page, not silently missing.
    batch = [order(id=10), order(id=11)]
    result = decide_batch(batch, 11)
    assert result["new_orders"] == []
    assert result["repeats"] == 2
    assert result["next_floor"] == 11


def test_empty_batch_keeps_the_same_floor():
    result = decide_batch([], 7)
    assert result["new_orders"] == []
    assert result["next_floor"] == 7


# decide: whether an order needs repair


def test_fix_when_stripe_succeeded_but_order_still_unpaid():
    assert decide(order(status="pending"), intent())[0] == "fix"


def test_skip_when_no_intent_saved():
    assert decide(order(status="pending"), None)[0] == "skip"


def test_skip_when_order_already_paid():
    assert decide(order(status="processing"), intent())[0] == "skip"


def test_skip_when_intent_not_succeeded():
    assert decide(order(status="pending"), intent(status="requires_payment_method"))[0] == "skip"


def test_mismatch_when_amount_differs():
    assert decide(order(status="pending", total="40.00"), intent())[0] == "mismatch"


# helpers


def test_intent_id_from_meta():
    o = order(meta_data=[{"key": "_stripe_intent_id", "value": "pi_123"}], transaction_id="")
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = order(meta_data=[], transaction_id="pi_456")
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = order(meta_data=[], transaction_id="ch_789")
    assert intent_id_of(o) is None


def test_order_amount_minor_converts_to_cents():
    assert order_amount_minor(order(total="19.99")) == 1999
