from fix_fee_net import recompute_net_fee, is_stale


def test_recompute_subtracts_refund():
    net, fee = recompute_net_fee({"net": 4700, "fee": 300}, [{"net": -2000, "fee": 0}])
    assert net == 2700 and fee == 300


def test_recompute_with_refunded_fee():
    net, fee = recompute_net_fee({"net": 4700, "fee": 300}, [{"net": -4700, "fee": -300}])
    assert net == 0 and fee == 0


def test_stale_detects_difference():
    assert is_stale(4700, 2700) is True


def test_not_stale_within_tolerance():
    assert is_stale(2700, 2700) is False
