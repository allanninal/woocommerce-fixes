from fix_purchasable_stock import decide_product, decide_order, intent_id_of, is_out_of_stock


def product(**over):
    base = {
        "id": 101,
        "stock_status": "outofstock",
        "manage_stock": True,
        "stock_quantity": 0,
        "backorders": "no",
        "purchasable": True,
        "catalog_visibility": "visible",
    }
    base.update(over)
    return base


def order(**over):
    base = {
        "id": 555,
        "status": "processing",
        "line_items": [{"product_id": 101}],
    }
    base.update(over)
    return base


def intent(**over):
    base = {"status": "succeeded", "id": "pi_1"}
    base.update(over)
    return base


# -- is_out_of_stock -----------------------------------------------------

def test_out_of_stock_flag_wins():
    assert is_out_of_stock(product(stock_status="outofstock", manage_stock=False)) is True


def test_in_stock_flag_with_unmanaged_stock_is_not_out_of_stock():
    assert is_out_of_stock(product(stock_status="instock", manage_stock=False)) is False


def test_managed_stock_zero_no_backorders_is_out_of_stock():
    assert is_out_of_stock(product(stock_status="instock", stock_quantity=0, backorders="no")) is True


def test_managed_stock_zero_with_backorders_is_not_out_of_stock():
    assert is_out_of_stock(product(stock_status="instock", stock_quantity=0, backorders="yes")) is False


def test_managed_stock_positive_is_not_out_of_stock():
    assert is_out_of_stock(product(stock_status="instock", stock_quantity=5)) is False


# -- decide_product -------------------------------------------------------

def test_repair_when_out_of_stock_and_purchasable():
    action, _ = decide_product(product(purchasable=True, catalog_visibility="visible"))
    assert action == "repair"


def test_repair_when_out_of_stock_and_still_listed_even_if_not_purchasable():
    action, _ = decide_product(product(purchasable=False, catalog_visibility="visible"))
    assert action == "repair"


def test_skip_when_already_locked_down():
    action, _ = decide_product(product(purchasable=False, catalog_visibility="search"))
    assert action == "skip"


def test_skip_when_in_stock():
    action, _ = decide_product(product(stock_status="instock", manage_stock=False))
    assert action == "skip"


# -- decide_order -----------------------------------------------------------

def test_flag_charged_when_order_open_and_payment_succeeded():
    action, _ = decide_order(order(), intent(), {101})
    assert action == "flag_charged"


def test_flag_uncharged_when_order_open_and_no_intent():
    action, _ = decide_order(order(), None, {101})
    assert action == "flag_uncharged"


def test_flag_uncharged_when_intent_not_succeeded():
    action, _ = decide_order(order(), intent(status="requires_payment_method"), {101})
    assert action == "flag_uncharged"


def test_skip_when_order_not_open():
    action, _ = decide_order(order(status="completed"), intent(), {101})
    assert action == "skip"


def test_skip_when_order_has_no_repaired_product():
    action, _ = decide_order(order(line_items=[{"product_id": 999}]), intent(), {101})
    assert action == "skip"


# -- intent_id_of -----------------------------------------------------------

def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None
