from clear_stale_carts import decide, cart_has_items


def cart_meta(**over):
    base = {
        "key": "_woocommerce_persistent_cart_1",
        "value": {"cart": {"abc123": {"quantity": 1}}},
    }
    base.update(over)
    return base


def test_clear_when_quiet_past_threshold():
    assert decide(cart_meta(), 200, 180)[0] == "clear"


def test_clear_reason_mentions_days():
    action, reason = decide(cart_meta(), 200, 180)
    assert action == "clear"
    assert "200" in reason and "180" in reason


def test_skip_when_no_meta():
    assert decide(None, 200, 180)[0] == "skip"


def test_skip_when_cart_is_empty():
    assert decide(cart_meta(value={"cart": {}}), 200, 180)[0] == "skip"


def test_skip_when_cart_value_missing():
    assert decide(cart_meta(value=""), 200, 180)[0] == "skip"


def test_skip_when_not_quiet_long_enough():
    assert decide(cart_meta(), 30, 180)[0] == "skip"


def test_skip_when_exactly_at_threshold_minus_one():
    assert decide(cart_meta(), 179, 180)[0] == "skip"


def test_clear_when_exactly_at_threshold():
    assert decide(cart_meta(), 180, 180)[0] == "clear"


def test_skip_when_days_quiet_is_none():
    assert decide(cart_meta(), None, 180)[0] == "skip"


def test_cart_has_items_true_for_real_cart():
    assert cart_has_items(cart_meta()) is True


def test_cart_has_items_false_for_none():
    assert cart_has_items(None) is False


def test_cart_has_items_false_for_empty_dict_value():
    assert cart_has_items({"value": {"cart": {}}}) is False
