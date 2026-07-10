from reconcile_stock import decide, line_items_needing_sync, reduced_stock_of, apply_delta


def line_item(**over):
    base = {
        "product_id": 42,
        "variation_id": 0,
        "sku": "WIDGET",
        "quantity": 2,
        "meta_data": [{"key": "_reduced_stock", "value": "2"}],
    }
    base.update(over)
    return base


def product(**over):
    base = {"manage_stock": True, "stock_quantity": 10}
    base.update(over)
    return base


def test_reduced_stock_of_reads_meta():
    assert reduced_stock_of(line_item()) == 2


def test_reduced_stock_of_defaults_to_zero_without_meta():
    assert reduced_stock_of(line_item(meta_data=[])) == 0


def test_needs_sync_when_quantity_was_edited_up():
    order = {"status": "processing", "line_items": [line_item(quantity=5)]}
    out = line_items_needing_sync(order)
    assert len(out) == 1
    assert out[0]["delta"] == 3


def test_needs_sync_when_quantity_was_edited_down():
    order = {"status": "processing", "line_items": [line_item(quantity=1)]}
    out = line_items_needing_sync(order)
    assert out[0]["delta"] == -1


def test_no_sync_needed_when_quantity_unchanged():
    order = {"status": "processing", "line_items": [line_item(quantity=2)]}
    assert line_items_needing_sync(order) == []


def test_skips_orders_not_in_stock_reducing_status():
    order = {"status": "pending", "line_items": [line_item(quantity=5)]}
    assert line_items_needing_sync(order) == []


def test_skips_line_items_without_a_product_id():
    order = {"status": "processing", "line_items": [line_item(product_id=None, quantity=5)]}
    assert line_items_needing_sync(order) == []


def test_new_line_item_added_after_reduction_needs_full_sync():
    # A line added by the admin after the order's stock was reduced has no
    # _reduced_stock meta at all, so the whole quantity is a delta to apply.
    order = {"status": "processing", "line_items": [line_item(quantity=3, meta_data=[])]}
    out = line_items_needing_sync(order)
    assert out[0]["reduced"] == 0
    assert out[0]["delta"] == 3


def test_decide_skip_when_order_not_stock_reducing():
    assert decide({"status": "pending"}, product())[0] == "skip"


def test_decide_orphan_when_product_missing():
    assert decide({"status": "processing"}, None)[0] == "orphan"


def test_decide_unmanaged_when_product_does_not_track_stock():
    assert decide({"status": "processing"}, product(manage_stock=False))[0] == "unmanaged"


def test_decide_adjust_when_stock_managed_and_order_paid():
    assert decide({"status": "completed"}, product())[0] == "adjust"


def test_apply_delta_adds_back_stock():
    assert apply_delta(10, 3) == 13


def test_apply_delta_removes_stock():
    assert apply_delta(10, -3) == 7


def test_apply_delta_never_goes_negative():
    assert apply_delta(2, -5) == 0
