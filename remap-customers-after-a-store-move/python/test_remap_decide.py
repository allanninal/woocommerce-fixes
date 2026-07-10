from remap_customers import decide, stripe_ids_agree


def order(**over):
    base = {"id": 482, "customer_id": 482}
    base.update(over)
    return base


def test_skip_when_current_customer_valid():
    assert decide(order(), True, [])[0] == "skip"


def test_orphan_when_no_email_match():
    assert decide(order(), False, [])[0] == "orphan"


def test_ambiguous_when_multiple_email_matches():
    users = [{"id": 219}, {"id": 340}]
    assert decide(order(), False, users)[0] == "ambiguous"


def test_remap_when_exactly_one_match_and_id_differs():
    users = [{"id": 219}]
    action, reason = decide(order(), False, users)
    assert action == "remap"
    assert "219" in reason


def test_skip_when_single_match_already_correct():
    users = [{"id": 482}]
    assert decide(order(customer_id=482), False, users)[0] == "skip"


def test_stripe_ids_agree_when_either_missing():
    assert stripe_ids_agree(None, "cus_123") is True
    assert stripe_ids_agree("cus_123", None) is True


def test_stripe_ids_agree_when_equal():
    assert stripe_ids_agree("cus_123", "cus_123") is True


def test_stripe_ids_disagree_when_different():
    assert stripe_ids_agree("cus_123", "cus_999") is False
