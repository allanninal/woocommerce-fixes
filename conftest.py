# Dummy environment so the scripts import cleanly during tests.
# The tests only exercise pure functions, so no real keys are ever used.
import os

os.environ.setdefault("STRIPE_SECRET_KEY", "sk_test_dummy")
os.environ.setdefault("WOO_STORE_URL", "https://example.com")
os.environ.setdefault("WOO_CONSUMER_KEY", "ck_dummy")
os.environ.setdefault("WOO_CONSUMER_SECRET", "cs_dummy")
