from refund_duplicates import duplicate_sets, choose_extras


def charge(cid, order_id, amount=5000, created=1, refunded=False, status="succeeded"):
    return {"id": cid, "amount": amount, "currency": "usd", "created": created,
            "refunded": refunded, "status": status, "metadata": {"order_id": order_id}}


def test_detects_two_charges_same_order_and_amount():
    dups = duplicate_sets([charge("ch_1", "42"), charge("ch_2", "42")])
    assert ("42", 5000) in dups


def test_ignores_single_charge():
    assert duplicate_sets([charge("ch_1", "42")]) == {}


def test_ignores_different_amounts():
    dups = duplicate_sets([charge("ch_1", "42", amount=5000), charge("ch_2", "42", amount=1000)])
    assert dups == {}


def test_ignores_refunded():
    dups = duplicate_sets([charge("ch_1", "42"), charge("ch_2", "42", refunded=True)])
    assert dups == {}


def test_keeps_recorded_charge():
    same = [charge("ch_1", "42", created=1), charge("ch_2", "42", created=2)]
    extras = choose_extras(same, "ch_2")
    assert [c["id"] for c in extras] == ["ch_1"]


def test_keeps_earliest_when_none_recorded():
    same = [charge("ch_1", "42", created=1), charge("ch_2", "42", created=2)]
    extras = choose_extras(same, None)
    assert [c["id"] for c in extras] == ["ch_2"]
