from check_webhook import endpoint_health

STORE = "shop.example.com"
ALL_EVENTS = ["payment_intent.succeeded", "payment_intent.payment_failed",
              "charge.succeeded", "charge.refunded"]


def ep(**over):
    base = {"id": "we_1", "status": "enabled",
            "url": "https://shop.example.com/?wc-ajax=wc_stripe",
            "enabled_events": ALL_EVENTS}
    base.update(over)
    return base


def test_healthy_endpoint_passes():
    r = endpoint_health(ep(), STORE)
    assert r["enabled"] and r["points_at_store"] and r["covers_events"]


def test_disabled_is_flagged():
    assert endpoint_health(ep(status="disabled"), STORE)["enabled"] is False


def test_wrong_domain_is_flagged():
    r = endpoint_health(ep(url="https://old-domain.com/?wc-ajax=wc_stripe"), STORE)
    assert r["points_at_store"] is False


def test_missing_events_are_listed():
    r = endpoint_health(ep(enabled_events=["charge.succeeded"]), STORE)
    assert "payment_intent.succeeded" in r["missing_events"]


def test_star_covers_everything():
    assert endpoint_health(ep(enabled_events=["*"]), STORE)["covers_events"] is True
