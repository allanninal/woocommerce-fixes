from sync_products_to_stripe import decide, stripe_ids_of, product_amount_minor


def product(**over):
    base = {"id": 42, "name": "Pro Plan", "status": "publish", "type": "subscription", "price": "50.00"}
    base.update(over)
    return base


def stripe_product(**over):
    base = {"id": "prod_1", "active": True}
    base.update(over)
    return base


def stripe_price(**over):
    base = {"id": "price_1", "active": True, "unit_amount": 5000}
    base.update(over)
    return base


def test_create_both_when_no_stripe_product():
    action, _ = decide(product(), None, None)
    assert action == "create_both"


def test_create_both_when_stripe_product_archived():
    action, _ = decide(product(), stripe_product(active=False), stripe_price())
    assert action == "create_both"


def test_create_price_when_price_missing():
    action, _ = decide(product(), stripe_product(), None)
    assert action == "create_price"


def test_create_price_when_price_archived():
    action, _ = decide(product(), stripe_product(), stripe_price(active=False))
    assert action == "create_price"


def test_create_price_when_amount_changed():
    action, _ = decide(product(price="60.00"), stripe_product(), stripe_price())
    assert action == "create_price"


def test_ok_when_already_in_sync():
    action, _ = decide(product(), stripe_product(), stripe_price())
    assert action == "ok"


def test_skip_when_not_published():
    action, _ = decide(product(status="draft"), None, None)
    assert action == "skip"


def test_skip_when_type_not_syncable():
    action, _ = decide(product(type="grouped"), None, None)
    assert action == "skip"


def test_skip_when_no_price_yet():
    action, _ = decide(product(price="0"), None, None)
    assert action == "skip"


def test_stripe_ids_of_reads_meta():
    p = product(meta_data=[
        {"key": "_stripe_product_id", "value": "prod_9"},
        {"key": "_stripe_price_id", "value": "price_9"},
    ])
    assert stripe_ids_of(p) == ("prod_9", "price_9")


def test_stripe_ids_of_missing_meta():
    assert stripe_ids_of(product()) == (None, None)


def test_product_amount_minor_uses_price_then_regular_price():
    assert product_amount_minor(product(price="19.99")) == 1999
    assert product_amount_minor({"regular_price": "19.99"}) == 1999
