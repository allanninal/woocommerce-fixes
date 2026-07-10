from assign_fallback_category import decide, has_category, intent_id_of


def product(**over):
    base = {"id": 42, "name": "Ceramic Mug", "status": "publish", "categories": []}
    base.update(over)
    return base


def test_fix_when_no_category_and_config_present():
    action, _ = decide(product(), fallback_category_id=99, recently_sold=False)
    assert action == "fix"


def test_fix_reason_mentions_sales_when_recently_sold():
    action, reason = decide(product(), fallback_category_id=99, recently_sold=True)
    assert action == "fix"
    assert "recent sales" in reason


def test_skip_when_product_already_has_a_category():
    p = product(categories=[{"id": 12, "name": "Mugs"}])
    action, _ = decide(p, fallback_category_id=99, recently_sold=False)
    assert action == "skip"


def test_skip_when_not_published():
    action, _ = decide(product(status="draft"), fallback_category_id=99, recently_sold=False)
    assert action == "skip"


def test_blocked_when_no_fallback_category_configured():
    action, reason = decide(product(), fallback_category_id=0, recently_sold=False)
    assert action == "blocked"
    assert "FALLBACK_CATEGORY_ID" in reason


def test_has_category_true_with_categories():
    assert has_category(product(categories=[{"id": 1, "name": "Mugs"}])) is True


def test_has_category_false_when_empty():
    assert has_category(product(categories=[])) is False


def test_has_category_false_when_missing_key():
    p = product()
    del p["categories"]
    assert has_category(p) is False


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
