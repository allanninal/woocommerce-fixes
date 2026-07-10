from promote_default_source import decide


def pm(id_="pm_1", fingerprint="fp_abc", created=100):
    return {"id": id_, "card": {"fingerprint": fingerprint}, "created": created}


def test_promote_when_source_matches_a_payment_method():
    action, payload = decide("src_1", "fp_abc", [pm()])
    assert action == "promote"
    assert payload == "pm_1"


def test_skip_when_already_a_payment_method():
    action, _ = decide("pm_1", "fp_abc", [pm()])
    assert action == "skip"


def test_skip_when_default_is_neither_source_nor_payment_method():
    action, _ = decide("ba_1", "fp_abc", [pm()])
    assert action == "skip"


def test_no_match_when_fingerprint_differs():
    action, _ = decide("src_1", "fp_xyz", [pm(fingerprint="fp_abc")])
    assert action == "no_match"


def test_no_match_when_no_payment_methods_at_all():
    action, _ = decide("src_1", "fp_abc", [])
    assert action == "no_match"


def test_no_default_when_customer_has_nothing_set():
    action, _ = decide(None, None, [])
    assert action == "no_default"


def test_no_match_when_fingerprint_is_none_even_with_methods_present():
    # A Source we could not retrieve a fingerprint for should never match blindly.
    action, _ = decide("src_1", None, [pm(fingerprint=None)])
    assert action == "no_match"


def test_promote_prefers_most_recently_created_match():
    older = pm(id_="pm_old", created=100)
    newer = pm(id_="pm_new", created=200)
    action, payload = decide("src_1", "fp_abc", [older, newer])
    assert action == "promote"
    assert payload == "pm_new"
