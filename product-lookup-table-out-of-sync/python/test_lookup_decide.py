from rebuild_lookup_rows import decide, product_price_minor, intent_id_of


def fact(**over):
    base = {"order_total_minor": 4500, "stripe_amount_minor": 4500, "discounted": False}
    base.update(over)
    return base


def test_resave_when_price_steadily_mismatched():
    product = {"price": "60.00", "purchasable": True, "stock_status": "instock", "stock_quantity": 5}
    facts = [fact(), fact()]
    assert decide(product, facts)[0] == "resave"


def test_ok_when_only_one_mismatch_below_threshold():
    product = {"price": "60.00", "purchasable": True, "stock_status": "instock", "stock_quantity": 5}
    facts = [fact()]
    assert decide(product, facts, min_mismatched_orders=2)[0] == "ok"


def test_ok_when_price_matches():
    product = {"price": "45.00", "purchasable": True, "stock_status": "instock", "stock_quantity": 5}
    facts = [fact(), fact()]
    assert decide(product, facts)[0] == "ok"


def test_discounted_orders_are_not_counted_as_mismatch():
    product = {"price": "60.00", "purchasable": True, "stock_status": "instock", "stock_quantity": 5}
    facts = [fact(discounted=True), fact(discounted=True)]
    assert decide(product, facts)[0] == "ok"


def test_skip_when_not_purchasable():
    product = {"price": "60.00", "purchasable": False, "stock_status": "instock", "stock_quantity": 5}
    assert decide(product, [fact(), fact()])[0] == "skip"


def test_resave_when_stock_says_instock_with_zero_quantity():
    product = {"price": "45.00", "purchasable": True, "stock_status": "instock", "stock_quantity": 0}
    assert decide(product, [fact()])[0] == "resave"


def test_skip_when_no_recent_orders():
    product = {"price": "45.00", "purchasable": True, "stock_status": "instock", "stock_quantity": 5}
    assert decide(product, [])[0] == "skip"


def test_mismatch_must_also_match_stripe_amount():
    # order total disagrees with current price, but also disagrees with the
    # Stripe amount, so this is not evidence of a stale lookup row, it is
    # evidence the order data itself is unreliable, and should not count.
    product = {"price": "60.00", "purchasable": True, "stock_status": "instock", "stock_quantity": 5}
    facts = [fact(order_total_minor=4500, stripe_amount_minor=4999), fact(order_total_minor=4500, stripe_amount_minor=4999)]
    assert decide(product, facts)[0] == "ok"


def test_product_price_minor_rounds_correctly():
    assert product_price_minor({"price": "19.99"}) == 1999


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
