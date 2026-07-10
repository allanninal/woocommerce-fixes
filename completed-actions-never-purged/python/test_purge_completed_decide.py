from datetime import datetime, timezone
from purge_completed_meta import decide, intent_id_of, purgeable_meta_ids

NOW = datetime(2026, 7, 10, tzinfo=timezone.utc)


def order(**over):
    base = {
        "status": "completed",
        "total": "50.00",
        "date_modified_gmt": "2026-01-01T00:00:00",
        "meta_data": [{"id": 1, "key": "_reconciler_checked_at", "value": "2026-01-01"}],
    }
    base.update(over)
    return base


def intent(**over):
    base = {"status": "succeeded", "amount_received": 5000}
    base.update(over)
    return base


def test_purge_when_settled_stale_and_confirmed():
    assert decide(order(), intent(), 90, now=NOW)[0] == "purge"


def test_skip_when_order_not_settled():
    assert decide(order(status="pending"), intent(), 90, now=NOW)[0] == "skip"


def test_skip_when_nothing_to_purge():
    assert decide(order(meta_data=[]), intent(), 90, now=NOW)[0] == "skip"


def test_skip_when_inside_retention_window():
    recent = order(date_modified_gmt="2026-07-01T00:00:00")
    assert decide(recent, intent(), 90, now=NOW)[0] == "skip"


def test_keep_when_stripe_no_longer_confirms():
    assert decide(order(), None, 90, now=NOW)[0] == "keep"


def test_keep_when_intent_status_not_succeeded():
    assert decide(order(), intent(status="canceled"), 90, now=NOW)[0] == "keep"


def test_keep_when_amount_no_longer_matches():
    assert decide(order(total="80.00"), intent(), 90, now=NOW)[0] == "keep"


def test_intent_id_from_meta():
    o = order(meta_data=[{"id": 2, "key": "_stripe_intent_id", "value": "pi_123"}], transaction_id="")
    assert intent_id_of(o) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    o = order(meta_data=[], transaction_id="pi_456")
    assert intent_id_of(o) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    o = order(meta_data=[], transaction_id="ch_789")
    assert intent_id_of(o) is None


def test_purgeable_meta_ids_only_known_keys():
    o = order(meta_data=[
        {"id": 1, "key": "_reconciler_checked_at", "value": "x"},
        {"id": 2, "key": "_billing_address_index", "value": "keep me"},
    ])
    assert purgeable_meta_ids(o) == [1]


def test_purgeable_meta_ids_empty_when_none_match():
    o = order(meta_data=[{"id": 3, "key": "_billing_address_index", "value": "keep me"}])
    assert purgeable_meta_ids(o) == []
