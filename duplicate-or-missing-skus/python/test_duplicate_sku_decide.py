from sku_audit import decide, group_by_sku


def entries(n, start_id=1, type_="product"):
    return [{"product_id": start_id + i, "type": type_} for i in range(n)]


def test_ok_when_unique_sku():
    assert decide("ABC-1", entries(1), has_paid_order=False)[0] == "ok"


def test_auto_fixable_when_duplicate_and_no_paid_order():
    action, reason = decide("ABC-1", entries(2), has_paid_order=False)
    assert action == "auto_fixable"
    assert "shared by 2" in reason


def test_review_when_duplicate_and_paid_order_exists():
    action, reason = decide("ABC-1", entries(2), has_paid_order=True)
    assert action == "review"
    assert "paid order" in reason


def test_auto_fixable_when_missing_sku_and_no_paid_order():
    action, reason = decide("", entries(3), has_paid_order=False)
    assert action == "auto_fixable"
    assert "missing SKU" in reason


def test_review_when_missing_sku_and_paid_order_exists():
    action, reason = decide("", entries(1), has_paid_order=True)
    assert action == "review"
    assert "missing SKU" in reason


def test_group_by_sku_groups_correctly():
    products = [
        {"id": 1, "sku": "ABC-1", "type": "product"},
        {"id": 2, "sku": "ABC-1", "type": "variation"},
        {"id": 3, "sku": "", "type": "product"},
        {"id": 4, "sku": " ", "type": "product"},
        {"id": 5, "sku": "XYZ-9", "type": "product"},
    ]
    groups = group_by_sku(products)
    assert len(groups["ABC-1"]) == 2
    assert len(groups[""]) == 2
    assert len(groups["XYZ-9"]) == 1


def test_group_by_sku_strips_whitespace():
    products = [{"id": 1, "sku": "  SPACED-1  ", "type": "product"}]
    groups = group_by_sku(products)
    assert "SPACED-1" in groups
    assert " SPACED-1  " not in groups
