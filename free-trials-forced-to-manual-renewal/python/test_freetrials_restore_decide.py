from restore_trial_billing import decide, usable_payment_method


class FakeCard:
    def __init__(self, exp_year, exp_month):
        self.exp_year = exp_year
        self.exp_month = exp_month


class FakePaymentMethod:
    def __init__(self, pm_id="pm_1", card=None):
        self.id = pm_id
        self.card = card if card is not None else FakeCard(2099, 12)


def test_restore_when_manual_and_card_found():
    sub = {"requires_manual_renewal": True}
    action, _ = decide(sub, FakePaymentMethod())
    assert action == "restore"


def test_skip_when_already_automatic():
    sub = {"requires_manual_renewal": False}
    action, _ = decide(sub, FakePaymentMethod())
    assert action == "skip"


def test_skip_when_no_payment_method():
    sub = {"requires_manual_renewal": True}
    action, _ = decide(sub, None)
    assert action == "skip"


def test_skip_reason_mentions_no_card_when_none_found():
    sub = {"requires_manual_renewal": True}
    _, reason = decide(sub, None)
    assert "no reusable payment method" in reason


def test_restore_reason_mentions_usable_card():
    sub = {"requires_manual_renewal": True}
    _, reason = decide(sub, FakePaymentMethod())
    assert "usable card" in reason


def test_usable_payment_method_returns_none_without_customer():
    assert usable_payment_method(None) is None
