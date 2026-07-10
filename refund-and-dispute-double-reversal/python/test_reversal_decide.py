from refund_dispute_double_reversal import decide, refunded_before


def test_skip_when_no_prior_refund():
    action, reason, loss = decide(5000, 0)
    assert action == "skip"
    assert loss == 0


def test_double_reversal_when_fully_refunded_first():
    action, reason, loss = decide(5000, 5000, dispute_fee=1500)
    assert action == "double_reversal"
    assert loss == 6500


def test_double_reversal_uses_smaller_of_dispute_and_refund():
    action, reason, loss = decide(5000, 2000, dispute_fee=1500)
    assert action == "double_reversal"
    assert loss == 3500


def test_double_reversal_when_partial_refund_covers_whole_dispute():
    # Refund of 8000 on a charge that is only disputed for 5000: the overlap
    # is capped at the disputed amount, not the (larger) refunded amount.
    action, reason, loss = decide(5000, 8000, dispute_fee=1500)
    assert action == "double_reversal"
    assert loss == 5000 + 1500


def test_default_dispute_fee_is_applied():
    action, reason, loss = decide(3000, 3000)
    assert loss == 3000 + 1500


def test_refunded_before_sums_only_succeeded_refunds_before_cutoff():
    charge = {
        "refunds": {
            "data": [
                {"status": "succeeded", "created": 100, "amount": 2000},
                {"status": "succeeded", "created": 200, "amount": 3000},  # after cutoff
                {"status": "failed", "created": 50, "amount": 1000},  # not succeeded
            ]
        }
    }
    assert refunded_before(charge, 150) == 2000


def test_refunded_before_returns_zero_when_no_refunds():
    assert refunded_before({"refunds": {"data": []}}, 100) == 0
    assert refunded_before({}, 100) == 0
