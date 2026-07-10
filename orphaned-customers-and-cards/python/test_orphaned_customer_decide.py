from find_orphaned_customers import decide


def customer(**over):
    base = {"id": "cus_1", "deleted": False, "metadata": {}, "has_active_subscription": False, "has_payment_method": False}
    base.update(over)
    return base


def woo_user(**over):
    base = {"id": 42, "email": "buyer@example.com"}
    base.update(over)
    return base


def test_ok_when_customer_and_user_agree():
    assert decide(customer(), woo_user())[0] == "ok"


def test_broken_link_when_customer_missing():
    assert decide(None, None)[0] == "broken-link"


def test_broken_link_when_customer_deleted():
    assert decide(customer(deleted=True), None)[0] == "broken-link"


def test_reconnect_when_metadata_points_elsewhere():
    action, _ = decide(customer(metadata={"woo_customer_id": "99"}), woo_user(id=42))
    assert action == "reconnect"


def test_reconnect_when_metadata_names_missing_user():
    action, _ = decide(customer(metadata={"woo_customer_id": "99"}), None)
    assert action == "reconnect"


def test_orphan_when_nothing_claims_it_and_nothing_attached():
    assert decide(customer(), None)[0] == "orphan"


def test_keep_when_orphan_has_active_subscription():
    action, _ = decide(customer(has_active_subscription=True), None)
    assert action == "keep"


def test_keep_when_orphan_has_saved_payment_method():
    action, _ = decide(customer(has_payment_method=True), None)
    assert action == "keep"
