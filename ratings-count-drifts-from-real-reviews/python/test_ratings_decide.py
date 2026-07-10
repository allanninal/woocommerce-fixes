from recount_ratings import decide, real_rating_stats


def review(rating):
    return {"rating": rating}


def test_skip_when_count_and_average_match():
    product = {"rating_count": 3, "average_rating": "4.33"}
    reviews = [review(4), review(4), review(5)]
    count, average = real_rating_stats(reviews)
    assert decide(product, count, average)[0] == "skip"


def test_recompute_when_count_is_stale():
    product = {"rating_count": 312, "average_rating": "4.8"}
    reviews = [review(5), review(4)]
    count, average = real_rating_stats(reviews)
    action, reason = decide(product, count, average)
    assert action == "recompute"
    assert "rating_count" in reason


def test_recompute_when_average_is_stale_but_count_matches():
    product = {"rating_count": 2, "average_rating": "5.0"}
    reviews = [review(1), review(1)]
    count, average = real_rating_stats(reviews)
    action, reason = decide(product, count, average)
    assert action == "recompute"
    assert "average_rating" in reason


def test_skip_within_rounding_tolerance():
    product = {"rating_count": 3, "average_rating": "4.3"}
    reviews = [review(4), review(4), review(5)]
    count, average = real_rating_stats(reviews)
    assert decide(product, count, average)[0] == "skip"


def test_recompute_when_no_rated_reviews_left_but_count_still_stored():
    product = {"rating_count": 5, "average_rating": "4.0"}
    reviews = [{"rating": None}, {"rating": 0}]
    count, average = real_rating_stats(reviews)
    action, reason = decide(product, count, average)
    assert action == "recompute"
    assert count == 0
    assert average == 0.0


def test_real_rating_stats_ignores_unrated_comments():
    reviews = [review(5), {"rating": None}, review(3)]
    count, average = real_rating_stats(reviews)
    assert count == 2
    assert average == 4.0
