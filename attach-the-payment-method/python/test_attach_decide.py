from attach_payment_method import decide, payment_method_id_of


def pm(**over):
    base = {"id": "pm_1", "customer": None}
    base.update(over)
    return base


def test_attach_when_unattached():
    assert decide("cus_1", pm())[0] == "attach"


def test_ok_when_already_attached_to_right_customer():
    assert decide("cus_1", pm(customer="cus_1"))[0] == "ok"


def test_conflict_when_attached_to_other_customer():
    assert decide("cus_1", pm(customer="cus_2"))[0] == "conflict"


def test_skip_when_no_payment_method():
    assert decide("cus_1", None)[0] == "skip"


def test_skip_when_no_stripe_customer_id():
    assert decide(None, pm())[0] == "skip"


def test_payment_method_id_prefers_transaction_id_pm():
    order = {"transaction_id": "pm_555", "meta_data": []}
    assert payment_method_id_of(order) == "pm_555"


def test_payment_method_id_falls_back_to_intent_meta():
    order = {"transaction_id": "", "meta_data": [{"key": "_stripe_intent_id", "value": "pi_999"}]}
    assert payment_method_id_of(order) == "pi_999"


def test_payment_method_id_none_when_nothing_saved():
    order = {"transaction_id": "", "meta_data": []}
    assert payment_method_id_of(order) is None
