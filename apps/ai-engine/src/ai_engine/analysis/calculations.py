"""Registry of derived calculations (CLAUDE.md rule 4). Pure Decimal arithmetic, no model involved.

Each function takes evidence from the ledger and adds the result as `derived` evidence. A
division by zero returns None: the caller must report the value as unknown, never invent one.
"""

from decimal import Decimal

from ai_engine.analysis.evidence import Evidence, EvidenceLedger, FormulaId


def _d(ev: Evidence) -> Decimal:
    return Decimal(str(ev.value))


def abs_change(ledger: EvidenceLedger, current: Evidence, previous: Evidence) -> Evidence:
    unit = current.unit
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


REGISTRY: tuple[FormulaId, ...] = (
    "pct_change",
    "abs_change",
    "share_of_total",
    "contribution_to_delta",
)
