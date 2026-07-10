from fix_negative_stock import is_oversold


def item(**over):
    base = {"manage_stock": True, "stock_quantity": -3}
    base.update(over)
    return base


def test_oversold_when_managed_and_negative():
    assert is_oversold(item()) is True


def test_not_oversold_when_zero():
    assert is_oversold(item(stock_quantity=0)) is False


def test_not_oversold_when_positive():
    assert is_oversold(item(stock_quantity=5)) is False


def test_not_oversold_when_stock_not_managed():
    assert is_oversold(item(manage_stock=False)) is False


def test_not_oversold_when_quantity_is_none():
    assert is_oversold(item(stock_quantity=None)) is False
