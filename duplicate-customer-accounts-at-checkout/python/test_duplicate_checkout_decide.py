from find_duplicate_accounts import decide, pick_survivor, group_by_email, normalize_email, intent_id_of


def customer(id, email="shopper@example.com", orders_count=0, date_created="2026-01-01T00:00:00"):
    return {"id": id, "email": email, "orders_count": orders_count, "date_created": date_created}


def order(id, intent_id="pi_1"):
    return {"id": id, "meta_data": [{"key": "_stripe_intent_id", "value": intent_id}], "transaction_id": ""}


def make_get_intent(customer_by_intent):
    def get_intent(intent_id):
        if intent_id is None or intent_id not in customer_by_intent:
            return None
        return {"id": intent_id, "customer": customer_by_intent[intent_id]}
    return get_intent


def test_skip_when_only_one_account():
    action, reason, survivor, duplicates = decide(
        "a@example.com", [customer(1)], {}, make_get_intent({})
    )
    assert action == "skip"


def test_merge_when_duplicate_has_no_orders():
    a = customer(1, orders_count=3)
    b = customer(2, orders_count=0)
    action, reason, survivor, duplicates = decide(
        "a@example.com", [a, b], {1: [order(101)], 2: []}, make_get_intent({"pi_1": "cus_survivor"})
    )
    assert action == "merge"
    assert survivor["id"] == 1
    assert [d["id"] for d in duplicates] == [2]


def test_merge_when_both_trace_to_same_stripe_customer():
    a = customer(1, orders_count=2)
    b = customer(2, orders_count=1)
    orders_by_customer = {1: [order(101, "pi_1")], 2: [order(102, "pi_2")]}
    get_intent = make_get_intent({"pi_1": "cus_same", "pi_2": "cus_same"})
    action, reason, survivor, duplicates = decide("a@example.com", [a, b], orders_by_customer, get_intent)
    assert action == "merge"
    assert survivor["id"] == 1


def test_review_when_stripe_customers_differ():
    a = customer(1, orders_count=2)
    b = customer(2, orders_count=1)
    orders_by_customer = {1: [order(101, "pi_1")], 2: [order(102, "pi_2")]}
    get_intent = make_get_intent({"pi_1": "cus_aaa", "pi_2": "cus_bbb"})
    action, reason, survivor, duplicates = decide("a@example.com", [a, b], orders_by_customer, get_intent)
    assert action == "review"


def test_pick_survivor_prefers_most_orders():
    a = customer(1, orders_count=1, date_created="2026-01-01T00:00:00")
    b = customer(2, orders_count=5, date_created="2026-02-01T00:00:00")
    assert pick_survivor([a, b])["id"] == 2


def test_pick_survivor_tie_breaks_on_earliest_created():
    a = customer(1, orders_count=2, date_created="2026-03-01T00:00:00")
    b = customer(2, orders_count=2, date_created="2026-01-01T00:00:00")
    assert pick_survivor([a, b])["id"] == 2


def test_group_by_email_normalizes_case_and_whitespace():
    customers = [customer(1, email="Shopper@Example.com "), customer(2, email=" shopper@example.com")]
    groups = group_by_email(customers)
    assert list(groups.keys()) == ["shopper@example.com"]
    assert len(groups["shopper@example.com"]) == 2


def test_group_by_email_ignores_singletons():
    customers = [customer(1, email="a@example.com"), customer(2, email="b@example.com")]
    assert group_by_email(customers) == {}


def test_intent_id_from_meta():
    o = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(o) is None


def test_normalize_email_handles_none():
    assert normalize_email(None) == ""
