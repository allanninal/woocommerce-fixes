from clear_stale_sessions import decide, intent_id_of, sessions_table_size_mb


def test_skip_when_under_threshold():
    assert decide(10.0, 50.0, 0)[0] == "skip"


def test_clear_when_over_threshold_and_no_open_checkout():
    assert decide(120.0, 50.0, 0)[0] == "clear"


def test_wait_when_over_threshold_but_checkout_in_progress():
    assert decide(120.0, 50.0, 2)[0] == "wait"


def test_skip_takes_priority_even_with_open_checkout():
    # If the table isn't actually bloated yet, an in-progress checkout is irrelevant.
    assert decide(5.0, 50.0, 3)[0] == "skip"


def test_boundary_meets_threshold_counts_as_bloated():
    assert decide(50.0, 50.0, 0)[0] == "clear"


def test_intent_id_from_meta():
    order = {"meta_data": [{"key": "_stripe_intent_id", "value": "pi_123"}], "transaction_id": ""}
    assert intent_id_of(order) == "pi_123"


def test_intent_id_falls_back_to_transaction_id():
    order = {"meta_data": [], "transaction_id": "pi_456"}
    assert intent_id_of(order) == "pi_456"


def test_intent_id_none_when_transaction_is_a_charge():
    order = {"meta_data": [], "transaction_id": "ch_789"}
    assert intent_id_of(order) is None


def test_sessions_table_size_mb_sums_data_and_index():
    status = {"database": {"database_tables": {"other": {
        "woocommerce_sessions": {"data": "4.10", "index": "0.15"}
    }}}}
    assert abs(sessions_table_size_mb(status) - 4.25) < 1e-9


def test_sessions_table_size_mb_missing_table_is_zero():
    status = {"database": {"database_tables": {"other": {}}}}
    assert sessions_table_size_mb(status) == 0
