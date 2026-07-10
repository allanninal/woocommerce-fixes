from import_migrated_cards import decide, customer_meta


def row(**over):
    base = {"old_customer_id": "old_1", "payment_method_id": "pm_123"}
    base.update(over)
    return base


def test_link_when_customer_found_and_not_yet_linked():
    customer = {"id": 9, "meta_data": []}
    assert decide(customer, row())[0] == "link"


def test_orphan_when_customer_missing():
    assert decide(None, row())[0] == "orphan"


def test_skip_when_payment_method_id_missing():
    customer = {"id": 9, "meta_data": []}
    assert decide(customer, row(payment_method_id=""))[0] == "skip"


def test_skip_when_payment_method_id_not_a_pm():
    customer = {"id": 9, "meta_data": []}
    assert decide(customer, row(payment_method_id="src_old_123"))[0] == "skip"


def test_skip_when_customer_already_linked():
    customer = {
        "id": 9,
        "meta_data": [{"key": "_stripe_payment_method_id", "value": "pm_999"}],
    }
    assert decide(customer, row())[0] == "skip"


def test_customer_meta_reads_matching_key():
    customer = {"meta_data": [{"key": "_stripe_customer_id", "value": "cus_1"}]}
    assert customer_meta(customer, "_stripe_customer_id") == "cus_1"


def test_customer_meta_returns_none_when_missing():
    customer = {"meta_data": []}
    assert customer_meta(customer, "_stripe_customer_id") is None
