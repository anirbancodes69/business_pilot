"""Deterministic time resolver (P-17). The model never does date arithmetic.

Relative tokens become absolute, inclusive dates from `now` (already in the tenant's time zone)
and the tenant's fiscal year start month. "This ..." periods run from the period start up to
today; "last ..." periods are complete. `last_n_days` ends today and includes it.
`last_n_months` is the n complete calendar months before the current month.
"""

import calendar
from datetime import date, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict

DateRange = tuple[date, date]
ComparisonType = Literal["previous_period", "same_period_last_year"]


class TimeResolutionError(ValueError):
    pass


def _month_start(d: date) -> date:
    return d.replace(day=1)


def _add_months(d: date, n: int) -> date:
    """First day of the month n months after d's month."""
    index = d.year * 12 + (d.month - 1) + n
    return date(index // 12, index % 12 + 1, 1)


def _month_end(d: date) -> date:
    return d.replace(day=calendar.monthrange(d.year, d.month)[1])


def _fiscal_year_start(d: date, start_month: int) -> date:
    year = d.year if d.month >= start_month else d.year - 1
    return date(year, start_month, 1)


def resolve_relative(
    period: str, n: int | None, now: datetime, fiscal_start_month: int
) -> DateRange:
    today = now.date()
    if period == "today":
        return today, today
    if period == "yesterday":
        y = today - timedelta(days=1)
        return y, y
    if period == "this_week":
        return today - timedelta(days=today.weekday()), today
    if period == "last_week":
        start = today - timedelta(days=today.weekday() + 7)
        return start, start + timedelta(days=6)
    if period == "this_month":
        return _month_start(today), today
    if period == "last_month":
        start = _add_months(today, -1)
        return start, _month_end(start)
    if period == "this_quarter":
        return _add_months(today, -((today.month - 1) % 3)), today
    if period == "last_quarter":
        start = _add_months(today, -((today.month - 1) % 3) - 3)
        return start, _month_end(_add_months(start, 2))
    if period == "this_year":
        return date(today.year, 1, 1), today
    if period == "last_year":
        return date(today.year - 1, 1, 1), date(today.year - 1, 12, 31)
    if period in ("fiscal_ytd", "this_fiscal_year"):
        return _fiscal_year_start(today, fiscal_start_month), today
    if period == "last_fiscal_year":
        this = _fiscal_year_start(today, fiscal_start_month)
        start = date(this.year - 1, fiscal_start_month, 1)
        return start, this - timedelta(days=1)
    if period in ("last_n_days", "last_n_months"):
        if n is None or n < 1:
            raise TimeResolutionError("n is required")
        if period == "last_n_days":
            return today - timedelta(days=n - 1), today
        return _add_months(today, -n), _month_end(_add_months(today, -1))
    raise TimeResolutionError("unknown relative period")


def resolve_comparison(kind: ComparisonType, current: DateRange) -> DateRange:
    start, end = current
    if kind == "same_period_last_year":

        def back(d: date) -> date:
            last = calendar.monthrange(d.year - 1, d.month)[1]
            return d.replace(year=d.year - 1, day=min(d.day, last))

        return back(start), back(end)
    if start.day == 1:
        # Whole months, or month-to-date: compare with the same stretch of the earlier month(s).
        months = (end.year - start.year) * 12 + end.month - start.month + 1
        prev_start = _add_months(start, -months)
        if end == _month_end(end):
            return prev_start, _month_end(_add_months(end, -months))
        prev_end = _month_end(_add_months(end, -months))
        return prev_start, min(prev_start + (end - start), prev_end)
    length = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    return prev_end - timedelta(days=length - 1), prev_end


class AbsoluteRange(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    start: date
    end: date
    time_dimension: str | None = None
