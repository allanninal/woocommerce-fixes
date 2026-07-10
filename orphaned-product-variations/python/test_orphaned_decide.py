from find_orphaned_variations import decide


def variation(**over):
    base = {"id": 501, "parent_id": 100}
    base.update(over)
    return base


def parent(**over):
    base = {"id": 100, "type": "variable", "status": "publish"}
    base.update(over)
    return base


def test_ok_when_parent_exists_and_variable():
    assert decide(variation(), parent())[0] == "ok"


def test_orphan_when_parent_missing():
    assert decide(variation(), None)[0] == "orphan"


def test_orphan_when_parent_trashed():
    assert decide(variation(), parent(status="trash"))[0] == "orphan"


def test_orphan_when_parent_converted_to_simple():
    assert decide(variation(), parent(type="simple"))[0] == "orphan"


def test_skip_when_variation_itself_gone():
    assert decide(None, None)[0] == "skip"


def test_skip_when_no_parent_id_set():
    assert decide(variation(parent_id=None), parent())[0] == "skip"
