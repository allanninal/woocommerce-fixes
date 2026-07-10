from restore_failed_stock import decide, intent_id_of, reduced_stock_flag, restockable_items


def order(**over):
    base = {
        "status": "failed",
        "meta_data": [{"key": "_order_stock_reduced", "value": "1"}],
        "line_items": [{"product_id": 101, "quantity": 2}],
    }
    base.update(over)
    return base


def test_restore_when_failed_and_flag_set():
    assert decide(order())[0] == "restore"


def test_restore_when_cancelled_and_flag_set():
    assert decide(order(status="cancelled"))[0] == "restore"


def test_skip_when_order_still_pending():
    assert decide(order(status="pending"))[0] == "skip"


def test_skip_when_flag_already_cleared():
    o = order(meta_data=[{"key": "_order_stock_reduced", "value": "0"}])
    assert decide(o)[0] == "skip"


def test_skip_when_flag_missing_entirely():
    o = order(meta_data=[])
    assert decide(o)[0] == "skip"


def test_skip_when_no_restockable_line_items():
    o = order(line_items=[{"product_id": None, "quantity": 2}])
    assert decide(o)[0] == "skip"


def test_reduced_stock_flag_true():
    assert reduced_stock_flag(order()) is True


def test_reduced_stock_flag_false_when_zero():
    o = order(meta_data=[{"key": "_order_stock_reduced", "value": "0"}])
    assert reduced_stock_flag(o) is False


def test_restockable_items_uses_variation_id_when_present():
    o = order(line_items=[{"product_id": 101, "variation_id": 202, "quantity": 3}])
    items = restockable_items(o)
    assert items == [{"product_id": 202, "quantity": 3}]


def test_restockable_items_skips_zero_quantity():
    o = order(line_items=[{"product_id": 101, "quantity": 0}])
    assert restockable_items(o) == []


def test_intent_id_from_meta():
    o = order(meta_data=[
        {"key": "_order_stock_reduced", "value": "1"},
        {"key": "_stripe_intent_id", "value": "pi_123"},
    ])
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = order(meta_data=[{"key": "_order_stock_reduced", "value": "1"}], transaction_id="pi_456")
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = order(meta_data=[{"key": "_order_stock_reduced", "value": "1"}], transaction_id="ch_789")
    assert intent_id_of(o) is None
