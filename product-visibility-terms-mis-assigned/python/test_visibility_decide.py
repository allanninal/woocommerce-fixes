from repair_visibility_terms import decide, expected_terms


def product(**over):
    base = {"id": 1, "catalog_visibility": "visible", "featured": False, "stock_status": "instock"}
    base.update(over)
    return base


def test_ok_when_terms_match_visible_product():
    assert decide(product(), [])[0] == "ok"


def test_repair_when_hidden_but_no_exclude_terms():
    assert decide(product(catalog_visibility="hidden"), [])[0] == "repair"


def test_ok_when_hidden_and_both_exclude_terms_present():
    assert decide(product(catalog_visibility="hidden"), ["exclude-from-search", "exclude-from-catalog"])[0] == "ok"


def test_repair_when_featured_flag_true_but_term_missing():
    assert decide(product(featured=True), [])[0] == "repair"


def test_repair_when_featured_term_present_but_flag_false():
    assert decide(product(featured=False), ["featured"])[0] == "repair"


def test_repair_when_out_of_stock_but_term_missing():
    assert decide(product(stock_status="outofstock"), [])[0] == "repair"


def test_ok_when_catalog_only_has_exclude_from_search():
    assert decide(product(catalog_visibility="catalog"), ["exclude-from-search"])[0] == "ok"


def test_repair_when_search_only_missing_exclude_from_catalog():
    assert decide(product(catalog_visibility="search"), [])[0] == "repair"


def test_skip_when_catalog_visibility_unrecognized():
    assert decide(product(catalog_visibility="whoops"), [])[0] == "skip"


def test_expected_terms_for_hidden_featured_out_of_stock():
    p = product(catalog_visibility="hidden", featured=True, stock_status="outofstock")
    assert expected_terms(p) == {"exclude-from-search", "exclude-from-catalog", "featured", "outofstock"}


def test_expected_terms_for_plain_visible_product():
    assert expected_terms(product()) == set()
