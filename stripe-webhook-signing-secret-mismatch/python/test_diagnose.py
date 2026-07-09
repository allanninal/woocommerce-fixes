from check_webhook_secret import diagnose_secret


def test_valid_secret_has_no_issues():
    assert diagnose_secret("whsec_abc123") == []


def test_empty_secret_is_flagged():
    assert diagnose_secret("") != []


def test_endpoint_id_is_flagged():
    assert "endpoint ID" in diagnose_secret("we_123")[0]


def test_random_value_is_flagged():
    assert diagnose_secret("hello")[0].startswith("the saved value")
