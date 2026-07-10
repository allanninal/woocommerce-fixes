from backfill_renewal_fees import decide, is_renewal_order, has_fee_and_net, intent_id_of, to_major


def renewal_order(**over):
    base = {
        "status": "processing",
        "meta_data": [
            {"key": "_subscription_renewal", "value": "9"},
            {"key": "_stripe_intent_id", "value": "pi_1"},
        ],
    }
    base.update(over)
    return base


def balance_transaction(**over):
    base = {"fee": 88, "net": 4912}
    base.update(over)
    return base


def test_fix_when_renewal_paid_and_missing_fee():
    assert decide(renewal_order(), balance_transaction())[0] == "fix"


def test_skip_when_not_a_renewal():
    order = {"status": "processing", "meta_data": [{"key": "_stripe_intent_id", "value": "pi_1"}]}
    assert decide(order, balance_transaction())[0] == "skip"


def test_skip_when_fee_and_net_already_saved():
    order = renewal_order(meta_data=[
        {"key": "_subscription_renewal", "value": "9"},
        {"key": "_stripe_intent_id", "value": "pi_1"},
        {"key": "_stripe_fee", "value": "0.88"},
        {"key": "_stripe_net", "value": "49.12"},
    ])
    assert decide(order, balance_transaction())[0] == "skip"


def test_skip_when_renewal_not_yet_paid():
    order = renewal_order(status="pending")
    assert decide(order, balance_transaction())[0] == "skip"


def test_skip_when_renewal_already_refunded_status():
    order = renewal_order(status="refunded")
    assert decide(order, balance_transaction())[0] == "skip"


def test_orphan_when_no_intent_id():
    order = renewal_order(meta_data=[{"key": "_subscription_renewal", "value": "9"}])
    assert decide(order, balance_transaction())[0] == "orphan"


def test_orphan_when_no_balance_transaction():
    assert decide(renewal_order(), None)[0] == "orphan"


def test_orphan_when_balance_transaction_missing_fee():
    bt = balance_transaction()
    del bt["fee"]
    assert decide(renewal_order(), bt)[0] == "orphan"


def test_orphan_when_balance_transaction_missing_net():
    bt = balance_transaction()
    del bt["net"]
    assert decide(renewal_order(), bt)[0] == "orphan"


def test_is_renewal_order_true_with_meta():
    assert is_renewal_order(renewal_order()) is True


def test_is_renewal_order_false_without_meta():
    assert is_renewal_order({"meta_data": []}) is False


def test_has_fee_and_net_false_when_partial():
    order = {"meta_data": [{"key": "_stripe_fee", "value": "0.88"}]}
    assert has_fee_and_net(order) is False


def test_has_fee_and_net_true_when_both_present():
    order = {"meta_data": [
        {"key": "_stripe_fee", "value": "0.88"},
        {"key": "_stripe_net", "value": "49.12"},
    ]}
    assert has_fee_and_net(order) is True


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_to_major_converts_cents_to_dollars():
    assert to_major(4912) == 49.12


def test_to_major_rounds_half_cent_up():
    assert to_major(4913) == 49.13
