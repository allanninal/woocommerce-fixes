from dedupe_saved_cards import decide, group_by_fingerprint


def pm(id_, fingerprint="fp_abc", created=1000):
    return {"id": id_, "created": created, "card": {"fingerprint": fingerprint}}


def test_single_card_is_kept():
    group = [pm("pm_1")]
    assert decide(group, set()) == {"pm_1": "keep"}


def test_duplicates_keep_newest_when_none_in_use():
    group = [pm("pm_1", created=1000), pm("pm_2", created=2000), pm("pm_3", created=1500)]
    result = decide(group, set())
    assert result == {"pm_1": "detach", "pm_2": "keep", "pm_3": "detach"}


def test_duplicates_keep_the_one_used_by_a_subscription():
    group = [pm("pm_1", created=1000), pm("pm_2", created=2000)]
    # pm_1 is older but a live subscription still points at it, so it wins.
    result = decide(group, {"pm_1"})
    assert result == {"pm_1": "keep", "pm_2": "detach"}


def test_multiple_in_use_are_all_kept():
    group = [pm("pm_1"), pm("pm_2"), pm("pm_3")]
    result = decide(group, {"pm_1", "pm_2"})
    assert result == {"pm_1": "keep", "pm_2": "keep", "pm_3": "detach"}


def test_group_by_fingerprint_splits_different_cards():
    methods = [pm("pm_1", fingerprint="fp_a"), pm("pm_2", fingerprint="fp_b"), pm("pm_3", fingerprint="fp_a")]
    groups = group_by_fingerprint(methods)
    assert set(groups.keys()) == {"fp_a", "fp_b"}
    assert {m["id"] for m in groups["fp_a"]} == {"pm_1", "pm_3"}
    assert {m["id"] for m in groups["fp_b"]} == {"pm_2"}


def test_group_by_fingerprint_skips_methods_without_one():
    methods = [{"id": "pm_1", "card": {}}, pm("pm_2")]
    groups = group_by_fingerprint(methods)
    assert list(groups.keys()) == ["fp_abc"]
