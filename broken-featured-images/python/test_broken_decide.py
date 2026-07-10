from repair_broken_images import decide, intent_id_of, payment_confirmed


def product(**over):
    base = {"id": 1, "images": [{"id": 55, "src": "https://example.com/wp-content/uploads/photo.jpg"}]}
    base.update(over)
    return base


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000}
    base.update(over)
    return base


def test_clear_when_image_not_reachable():
    assert decide(product(), False)[0] == "clear"


def test_skip_when_image_reachable():
    assert decide(product(), True)[0] == "skip"


def test_skip_when_no_images_at_all():
    assert decide(product(images=[]), None)[0] == "skip"


def test_skip_when_no_reachability_result():
    assert decide(product(), None)[0] == "skip"


def test_payment_confirmed_true_when_matching_and_succeeded():
    order = {"status": "processing", "total": "50.00"}
    assert payment_confirmed(order, intent()) is True


def test_payment_confirmed_false_when_order_not_paid_status():
    order = {"status": "pending", "total": "50.00"}
    assert payment_confirmed(order, intent()) is False


def test_payment_confirmed_false_when_no_intent():
    order = {"status": "processing", "total": "50.00"}
    assert payment_confirmed(order, None) is False


def test_payment_confirmed_false_when_intent_not_succeeded():
    order = {"status": "processing", "total": "50.00"}
    assert payment_confirmed(order, intent(status="requires_payment_method")) is False


def test_payment_confirmed_false_when_amount_mismatch():
    order = {"status": "processing", "total": "80.00"}
    assert payment_confirmed(order, intent()) is False


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None
