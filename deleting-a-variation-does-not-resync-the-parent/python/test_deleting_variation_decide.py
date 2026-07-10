from resync_variable_parent import decide, expected_state, price_minor


def variation(**over):
    base = {"status": "publish", "price": "20.00", "stock_status": "instock"}
    base.update(over)
    return base


def parent(**over):
    base = {"type": "variable", "price": "20.00", "stock_status": "instock"}
    base.update(over)
    return base


def test_price_minor_handles_empty_and_none():
    assert price_minor("") is None
    assert price_minor(None) is None
    assert price_minor("19.99") == 1999


def test_skip_for_simple_product():
    action, _, _ = decide({"type": "simple", "price": "10.00"}, [])
    assert action == "skip"


def test_skip_when_parent_already_matches():
    variations = [variation(price="20.00"), variation(price="35.00")]
    action, _, _ = decide(parent(price="20.00", stock_status="instock"), variations)
    assert action == "skip"


def test_fix_when_cheapest_variation_was_deleted():
    # The 15.00 variation was deleted. Only 20.00 and 35.00 remain, but the
    # parent still caches 15.00 as its low price.
    variations = [variation(price="20.00"), variation(price="35.00")]
    action, reason, expected = decide(parent(price="15.00", stock_status="instock"), variations)
    assert action == "fix"
    assert expected["min_price"] == 2000
    assert expected["max_price"] == 3500


def test_fix_when_last_in_stock_variation_was_deleted():
    # Only an out of stock variation is left, but the parent still says instock.
    variations = [variation(price="20.00", stock_status="outofstock")]
    action, reason, expected = decide(parent(price="20.00", stock_status="instock"), variations)
    assert action == "fix"
    assert expected["stock_status"] == "outofstock"


def test_no_variations_when_every_variation_deleted():
    action, reason, expected = decide(parent(price="20.00", stock_status="instock"), [])
    assert action == "no-variations"
    assert expected["min_price"] is None
    assert expected["stock_status"] == "outofstock"


def test_skip_when_no_variations_and_parent_already_cleared():
    action, _, _ = decide(parent(price="", stock_status="outofstock"), [])
    assert action == "skip"


def test_expected_state_ignores_draft_variations():
    variations = [variation(price="20.00", status="private"), variation(price="35.00")]
    expected = expected_state(variations)
    assert expected["min_price"] == 3500
    assert expected["max_price"] == 3500


def test_expected_state_backorder_counts_as_purchasable():
    variations = [variation(price="20.00", stock_status="onbackorder")]
    expected = expected_state(variations)
    assert expected["stock_status"] == "onbackorder"


def test_expected_state_all_out_of_stock():
    variations = [variation(price="20.00", stock_status="outofstock"), variation(price="30.00", stock_status="outofstock")]
    expected = expected_state(variations)
    assert expected["stock_status"] == "outofstock"
    assert expected["min_price"] == 2000
