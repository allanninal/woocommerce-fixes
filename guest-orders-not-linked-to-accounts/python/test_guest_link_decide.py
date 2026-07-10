from link_guest_orders import decide, intent_id_of, order_amount_minor


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000}
    base.update(over)
    return base


def customer(id_=42):
    return [{"id": id_, "email": "shopper@example.com"}]


def test_link_when_one_account_matches_and_paid():
    order = {"customer_id": 0, "status": "processing", "total": "50.00",
             "billing": {"email": "shopper@example.com"}}
    assert decide(order, customer(), intent())[0] == "link"


def test_skip_when_already_linked():
    order = {"customer_id": 42, "status": "processing", "total": "50.00",
             "billing": {"email": "shopper@example.com"}}
    assert decide(order, customer(), intent())[0] == "skip"


def test_skip_when_no_billing_email():
    order = {"customer_id": 0, "status": "processing", "total": "50.00", "billing": {}}
    assert decide(order, [], None)[0] == "skip"


def test_skip_when_not_paid_and_require_paid():
    order = {"customer_id": 0, "status": "pending", "total": "50.00",
             "billing": {"email": "shopper@example.com"}}
    assert decide(order, customer(), None)[0] == "skip"


def test_no_account_when_no_customers_found():
    order = {"customer_id": 0, "status": "processing", "total": "50.00",
             "billing": {"email": "nobody@example.com"}}
    assert decide(order, [], intent())[0] == "no_account"


def test_ambiguous_when_multiple_accounts_share_email():
    order = {"customer_id": 0, "status": "processing", "total": "50.00",
             "billing": {"email": "shopper@example.com"}}
    two = customer(1) + customer(2)
    assert decide(order, two, intent())[0] == "ambiguous"


def test_unverified_when_no_intent_saved():
    order = {"customer_id": 0, "status": "processing", "total": "50.00",
             "billing": {"email": "shopper@example.com"}}
    assert decide(order, customer(), None)[0] == "unverified"


def test_unverified_when_intent_not_succeeded():
    order = {"customer_id": 0, "status": "processing", "total": "50.00",
             "billing": {"email": "shopper@example.com"}}
    assert decide(order, customer(), intent(status="requires_action"))[0] == "unverified"


def test_unverified_when_amount_mismatch():
    order = {"customer_id": 0, "status": "processing", "total": "80.00",
             "billing": {"email": "shopper@example.com"}}
    assert decide(order, customer(), intent())[0] == "unverified"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_order_amount_minor_converts_to_cents():
    assert order_amount_minor({"total": "19.99"}) == 1999
