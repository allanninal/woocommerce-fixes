from find_orphaned_subscriptions import decide


def subscription(**over):
    base = {"id": 501, "status": "active", "customer_id": 42}
    base.update(over)
    return base


def test_ok_when_customer_id_set_and_user_exists():
    action, _ = decide(subscription(), True, None)
    assert action == "ok"


def test_reattach_when_customer_id_zero_but_stripe_names_owner():
    action, _ = decide(subscription(customer_id=0), False, 77)
    assert action == "reattach"


def test_reattach_when_customer_id_points_at_deleted_user():
    action, _ = decide(subscription(customer_id=42), False, 77)
    assert action == "reattach"


def test_orphan_when_no_customer_and_no_stripe_owner():
    action, _ = decide(subscription(customer_id=0), False, None)
    assert action == "orphan"


def test_skip_when_status_is_cancelled():
    action, _ = decide(subscription(status="cancelled", customer_id=0), False, None)
    assert action == "skip"


def test_skip_when_status_is_pending():
    action, _ = decide(subscription(status="pending", customer_id=0), False, None)
    assert action == "skip"


def test_ok_takes_priority_even_with_a_stripe_owner_present():
    # A healthy subscription should never be touched, even if a stray
    # metadata value happens to be present.
    action, _ = decide(subscription(), True, 99)
    assert action == "ok"
