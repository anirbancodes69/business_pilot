"""Number rendering in the tenant's format (Indian grouping, lakh and crore)."""

from decimal import ROUND_HALF_UP, Decimal

LAKH = Decimal(100_000)
CRORE = Decimal(10_000_000)


def _group_indian(integer_digits: str) -> str:
    if len(integer_digits) <= 3:
        return integer_digits
    head, tail = integer_digits[:-3], integer_digits[-3:]
    parts: list[str] = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return ",".join([*parts, tail])


def _group_international(integer_digits: str) -> str:
    return f"{int(integer_digits):,}"


def _plain(value: Decimal, places: int, number_format: str) -> str:
    q = value.copy_abs().quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
    whole, _, frac = f"{q:f}".partition(".")
    grouped = (_group_indian if number_format == "indian" else _group_international)(whole)
    sign = "-" if value < 0 and q != 0 else ""
    return f"{sign}{grouped}{'.' + frac if frac else ''}"


def format_number(value: float | Decimal, unit: str | None, number_format: str = "indian") -> str:
    """Render one number. Currency uses lakh and crore words in the Indian format."""
    v = Decimal(str(value)) if not isinstance(value, Decimal) else value
    if unit == "percent":
        return f"{_plain(v, 1, number_format)}%"
    if unit == "currency":
        sign = "-" if v < 0 else ""
        a = v.copy_abs()
        if number_format == "indian" and a >= CRORE:
            return f"{sign}₹{_plain(a / CRORE, 2, number_format)} crore"
        if number_format == "indian" and a >= LAKH:
            return f"{sign}₹{_plain(a / LAKH, 2, number_format)} lakh"
        return f"{sign}₹{_plain(a, 0, number_format)}"
    places = 0 if v == v.to_integral_value() else 2
    suffix = {"days": " days"}.get(unit or "", "")
    return f"{_plain(v, places, number_format)}{suffix}"
