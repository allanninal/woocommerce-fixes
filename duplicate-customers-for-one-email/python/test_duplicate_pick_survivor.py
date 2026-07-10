from merge_duplicate_customers import decide, pick_survivor, group_by_email, order_amount_minor


def cust(id, created, order_count=0, has_subscription=False, email="shopper@example.com"):
    return {
        "id": id,
        "email": email,
        "created": created,
        "order_count": order_count,
        "has_subscription": has_subscription,
    }


def test_pick_survivor_prefers_active_subscription():
    a = cust("cus_a", created=100, order_count=5)
    b = cust("cus_b", created=200, order_count=1, has_subscription=True)
    survivor, duplicates = pick_survivor([a, b])
    assert survivor["id"] == "cus_b"
    assert duplicates == [a]


def test_pick_survivor_prefers_most_orders_when_no_subscription():
    a = cust("cus_a", created=100, order_count=1)
    b = cust("cus_b", created=200, order_count=9)
    survivor, duplicates = pick_survivor([a, b])
    assert survivor["id"] == "cus_b"
    assert duplicates == [a]


def test_pick_survivor_ties_go_to_oldest():
    a = cust("cus_a", created=100, order_count=3)
    b = cust("cus_b", created=200, order_count=3)
    survivor, _ = pick_survivor([a, b])
    assert survivor["id"] == "cus_a"


def test_pick_survivor_single_customer_is_a_no_op():
    a = cust("cus_a", created=100, order_count=3)
    survivor, duplicates = pick_survivor([a])
    assert survivor["id"] == "cus_a"
    assert duplicates == []


def test_pick_survivor_empty_list():
    survivor, duplicates = pick_survivor([])
    assert survivor is None
    assert duplicates == []


def test_decide_skips_single_customer():
    a = cust("cus_a", created=100, order_count=3)
    plan = decide("shopper@example.com", [a])
    assert plan["action"] == "skip"


def test_decide_merges_multiple_customers():
    a = cust("cus_a", created=100, order_count=1)
    b = cust("cus_b", created=200, order_count=9)
    plan = decide("shopper@example.com", [a, b])
    assert plan["action"] == "merge"
    assert plan["survivor"]["id"] == "cus_b"
    assert plan["duplicates"] == [a]


def test_decide_skips_when_no_customers_at_all():
    plan = decide("nobody@example.com", [])
    assert plan["action"] == "skip"
    assert plan["survivor"] is None


def test_group_by_email_normalizes_case_and_whitespace():
    customers = [
        cust("cus_a", 100, email=" Shopper@Example.com "),
        cust("cus_b", 200, email="shopper@example.com"),
        cust("cus_c", 300, email="other@example.com"),
    ]
    groups = group_by_email(customers)
    assert sorted(groups.keys()) == ["other@example.com", "shopper@example.com"]
    assert len(groups["shopper@example.com"]) == 2


def test_group_by_email_drops_customers_with_no_email():
    customers = [cust("cus_a", 100, email=""), cust("cus_b", 200, email=None)]
    groups = group_by_email(customers)
    assert groups == {}


def test_order_amount_minor_converts_to_cents():
    assert order_amount_minor({"total": "49.99"}) == 4999
    assert order_amount_minor({"total": "10"}) == 1000
