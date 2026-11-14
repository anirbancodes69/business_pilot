from datetime import date, datetime, timedelta, timezone

import pytest

from ai_engine.planning.time_resolver import (
    TimeResolutionError,
    resolve_comparison,
    resolve_relative,
)

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2026, 11, 14, 10, 0, tzinfo=IST)  # a Saturday


def r(period: str, n: int | None = None) -> tuple[str, str]:
    start, end = resolve_relative(period, n, NOW, 4)
    return start.isoformat(), end.isoformat()


@pytest.mark.parametrize(
    ("period", "n", "expected"),
    [
        ("today", None, ("2026-11-14", "2026-11-14")),
        ("yesterday", None, ("2026-11-13", "2026-11-13")),
        ("this_week", None, ("2026-11-09", "2026-11-14")),
        ("last_week", None, ("2026-11-02", "2026-11-08")),
        ("this_month", None, ("2026-11-01", "2026-11-14")),
        ("last_month", None, ("2026-10-01", "2026-10-31")),
        ("this_quarter", None, ("2026-10-01", "2026-11-14")),
        ("last_quarter", None, ("2026-07-01", "2026-09-30")),
        ("this_year", None, ("2026-01-01", "2026-11-14")),
        ("last_year", None, ("2025-01-01", "2025-12-31")),
        ("fiscal_ytd", None, ("2026-04-01", "2026-11-14")),
        ("last_fiscal_year", None, ("2025-04-01", "2026-03-31")),
        ("last_n_days", 7, ("2026-11-08", "2026-11-14")),
        ("last_n_months", 3, ("2026-08-01", "2026-10-31")),
    ],
)
def test_relative_periods(period: str, n: int | None, expected: tuple[str, str]) -> None:
    assert r(period, n) == expected


def test_fiscal_year_before_the_start_month_and_year_boundaries() -> None:
    jan = datetime(2027, 1, 15, tzinfo=IST)
    assert resolve_relative("fiscal_ytd", None, jan, 4) == (date(2026, 4, 1), date(2027, 1, 15))
    assert resolve_relative("last_month", None, jan, 4) == (date(2026, 12, 1), date(2026, 12, 31))
    assert resolve_relative("last_quarter", None, jan, 4) == (date(2026, 10, 1), date(2026, 12, 31))


def test_missing_n_and_unknown_periods_are_errors() -> None:
    with pytest.raises(TimeResolutionError):
        resolve_relative("last_n_days", None, NOW, 4)
    with pytest.raises(TimeResolutionError):
        resolve_relative("next_week", None, NOW, 4)


def test_previous_period_follows_calendar_shape() -> None:
    d = date.fromisoformat
    assert resolve_comparison("previous_period", (d("2026-10-01"), d("2026-10-31"))) == (
        d("2026-09-01"),
        d("2026-09-30"),
    )
    assert resolve_comparison("previous_period", (d("2026-07-01"), d("2026-09-30"))) == (
        d("2026-04-01"),
        d("2026-06-30"),
    )
    # month to date compares with the same stretch of the month before
    assert resolve_comparison("previous_period", (d("2026-11-01"), d("2026-11-14"))) == (
        d("2026-10-01"),
        d("2026-10-14"),
    )
    # a short month before is clamped
    assert resolve_comparison("previous_period", (d("2026-03-01"), d("2026-03-31"))) == (
        d("2026-02-01"),
        d("2026-02-28"),
    )
    # anything else is the equal-length stretch just before
    assert resolve_comparison("previous_period", (d("2026-11-08"), d("2026-11-14"))) == (
        d("2026-11-01"),
        d("2026-11-07"),
    )


def test_same_period_last_year_clamps_leap_days() -> None:
    d = date.fromisoformat
    assert resolve_comparison("same_period_last_year", (d("2028-02-01"), d("2028-02-29"))) == (
        d("2027-02-01"),
        d("2027-02-28"),
    )
