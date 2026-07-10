from swap_reissued_card import decide, current_card_token, customer_id_of


AFFECTED = {"pm_old_1", "pm_old_2"}


def sub(status="active", token="pm_old_1", customer="cus_1"):
    meta = []
    if token:
        meta.append({"key": "_stripe_source_id", "value": token})
    if customer:
        meta.append({"key": "_stripe_customer_id", "value": customer})
    return {"id": 42, "status": status, "meta_data": meta}


def pm(pm_id="pm_new_1"):
    return {"id": pm_id}


def test_swap_when_on_reissued_range_and_clean_replacement_ready():
    assert decide(sub(), AFFECTED, pm("pm_new_1"))[0] == "swap"


def test_skip_when_subscription_not_active():
    assert decide(sub(status="cancelled"), AFFECTED, pm("pm_new_1"))[0] == "skip"


def test_skip_when_no_stored_token():
    assert decide(sub(token=None), AFFECTED, pm("pm_new_1"))[0] == "skip"


def test_skip_when_token_not_in_affected_range():
    assert decide(sub(token="pm_fine_1"), AFFECTED, pm("pm_new_1"))[0] == "skip"


def test_needs_attention_when_no_replacement_on_file():
    assert decide(sub(), AFFECTED, None)[0] == "needs-attention"


def test_needs_attention_when_default_is_also_affected():
    assert decide(sub(), AFFECTED, pm("pm_old_2"))[0] == "needs-attention"


def test_skip_when_already_on_the_new_token():
    assert decide(sub(token="pm_new_1"), AFFECTED, pm("pm_new_1"))[0] == "skip"


def test_current_card_token_reads_stripe_source_id():
    assert current_card_token(sub(token="pm_old_1")) == "pm_old_1"


def test_customer_id_of_reads_stripe_customer_id():
    assert customer_id_of(sub(customer="cus_99")) == "cus_99"
