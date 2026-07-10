from cancel_duplicate_renewals import decide, choose_keeper, renewal_key, group_renewals


def order(id, status, total="20.00", sub_id="55", renewal_date="2026-07-01 00:00:00"):
    meta = []
    if sub_id is not None:
        meta.append({"key": "_subscription_renewal", "value": sub_id})
    if renewal_date is not None:
        meta.append({"key": "_subscription_renewal_date", "value": renewal_date})
    return {"id": id, "status": status, "total": total, "meta_data": meta}


def test_single_order_is_left_alone():
    group = [order(1, "processing")]
    results = decide(group)
    assert results[0][1] == "skip"


def test_keeps_paid_cancels_unpaid_duplicate():
    paid = order(1, "processing")
    unpaid = order(2, "pending")
    results = {o["id"]: (action, reason) for o, action, reason in decide([paid, unpaid])}
    assert results[1][0] == "keep"
    assert results[2][0] == "cancel"


def test_cancels_failed_duplicate():
    paid = order(1, "processing")
    failed = order(2, "failed")
    results = {o["id"]: action for o, action, _ in decide([paid, failed])}
    assert results[1] == "keep"
    assert results[2] == "cancel"


def test_cancels_on_hold_duplicate():
    paid = order(1, "completed")
    on_hold = order(2, "on-hold")
    results = {o["id"]: action for o, action, _ in decide([paid, on_hold])}
    assert results[2] == "cancel"


def test_keeps_oldest_when_none_are_paid():
    a = order(5, "pending")
    b = order(9, "pending")
    results = {o["id"]: action for o, action, _ in decide([a, b])}
    assert results[5] == "keep"
    assert results[9] == "cancel"


def test_flags_two_paid_orders_instead_of_cancelling():
    a = order(3, "processing")
    b = order(4, "completed")
    results = {o["id"]: action for o, action, _ in decide([a, b])}
    # One is kept, the other is flagged for a human, never auto cancelled,
    # because two genuinely paid orders in one cycle is a real double charge.
    actions = set(results.values())
    assert "cancel" not in actions
    assert "flag" in actions
    assert "keep" in actions


def test_flags_paid_order_stripe_says_not_succeeded():
    keeper = order(1, "processing")
    suspect = order(2, "completed")
    intents = {2: {"status": "requires_payment_method"}}
    results = {o["id"]: action for o, action, _ in decide([keeper, suspect], intents)}
    assert results[2] == "flag"


def test_skips_refunded_duplicate_instead_of_cancelling():
    paid = order(1, "processing")
    refunded = order(2, "refunded")
    results = {o["id"]: action for o, action, _ in decide([paid, refunded])}
    assert results[2] == "skip"


def test_choose_keeper_prefers_paid_order():
    paid = order(9, "processing")
    unpaid = order(2, "pending")
    assert choose_keeper([unpaid, paid])["id"] == 9


def test_choose_keeper_falls_back_to_oldest_id():
    a = order(7, "pending")
    b = order(3, "pending")
    assert choose_keeper([a, b])["id"] == 3


def test_renewal_key_requires_both_meta_fields():
    assert renewal_key(order(1, "pending", sub_id=None)) is None
    assert renewal_key(order(1, "pending", renewal_date=None)) is None
    assert renewal_key(order(1, "pending")) == ("55", "2026-07-01 00:00:00")


def test_group_renewals_groups_by_subscription_and_date():
    a = order(1, "processing", sub_id="10", renewal_date="2026-07-01 00:00:00")
    b = order(2, "pending", sub_id="10", renewal_date="2026-07-01 00:00:00")
    c = order(3, "processing", sub_id="10", renewal_date="2026-08-01 00:00:00")
    groups = group_renewals([a, b, c])
    assert len(groups[("10", "2026-07-01 00:00:00")]) == 2
    assert len(groups[("10", "2026-08-01 00:00:00")]) == 1
