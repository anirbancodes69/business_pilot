"""Registry of derived calculations (CLAUDE.md rule 4). Pure Decimal arithmetic, no model involved.

Each function takes evidence from the ledger and adds the result as `derived` evidence. A
division by zero returns None: the caller must report the value as unknown, never invent one.
"""

from decimal import Decimal

from ai_engine.analysis.evidence import Evidence, EvidenceLedger, FormulaId


def _d(ev: Evidence) -> Decimal:
    return Decimal(str(ev.value))


def abs_change(ledger: EvidenceLedger, current: Evidence, previous: Evidence) -> Evidence:
    # A change between two percentages is in percentage points, not in percent.
    unit = "percentage_points" if current.unit == "percent" else current.unit
    return ledger.add_derived(
        _d(current) - _d(previous), unit, "abs_change", (current.id, previous.id)
    )


def pct_change(ledger: EvidenceLedger, current: Evidence, previous: Evidence) -> Evidence | None:
    if _d(previous) == 0:
        return None
    value = (_d(current) - _d(previous)) / abs(_d(previous)) * 100
    return ledger.add_derived(value, "percent", "pct_change", (current.id, previous.id))


def share_of_total(ledger: EvidenceLedger, part: Evidence, total: Evidence) -> Evidence | None:
    if _d(total) == 0:
        return None
    return ledger.add_derived(
        _d(part) / _d(total) * 100, "percent", "share_of_total", (part.id, total.id)
    )


def contribution_to_delta(
    ledger: EvidenceLedger, member_delta: Evidence, total_delta: Evidence
) -> Evidence | None:
    """Share of the overall change that one member explains (can exceed 100% or be negative)."""
    if _d(total_delta) == 0:
        return None
    value = _d(member_delta) / _d(total_delta) * 100
    return ledger.add_derived(
        value, "percent", "contribution_to_delta", (member_delta.id, total_delta.id)
    )


def sum_of_changes(ledger: EvidenceLedger, changes: list[Evidence]) -> Evidence:
    """The total of several members' changes (used to size a drill-down's own total)."""
    total = sum((_d(c) for c in changes), Decimal(0))
    unit = changes[0].unit if changes else None
    return ledger.add_derived(total, unit, "sum_of_changes", tuple(c.id for c in changes))


def one_period_change(ledger: EvidenceLedger, value: Evidence, appeared: bool) -> Evidence:
    """A member present in one period only: its whole value is the change (plus if it appeared)."""
    signed = _d(value) if appeared else -_d(value)
    return ledger.add_derived(signed, value.unit, "one_period_change", (value.id,))


def sum_of_values(ledger: EvidenceLedger, values: list[Evidence]) -> Evidence:
    """The total of several figures that were read from the data (for example the largest few)."""
    total = sum((_d(v) for v in values), Decimal(0))
    unit = values[0].unit if values else None
    return ledger.add_derived(total, unit, "sum_of_values", tuple(v.id for v in values))


REGISTRY: tuple[FormulaId, ...] = (
    "pct_change",
    "abs_change",
    "share_of_total",
    "contribution_to_delta",
    "sum_of_changes",
    "one_period_change",
    "sum_of_values",
)
