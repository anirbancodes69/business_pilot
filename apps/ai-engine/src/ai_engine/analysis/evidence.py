"""Evidence ledger (D-22): exactly one provenance record for every number shown to a user."""

import hashlib
import json
import re
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict

from ai_engine.analysis.formatting import format_number

FormulaId = Literal[
    "pct_change",
    "abs_change",
    "share_of_total",
    "contribution_to_delta",
    "sum_of_changes",
    "one_period_change",
    "sum_of_values",
]
EVIDENCE_ID = re.compile(r"^ev_[a-z0-9]{4,16}$")


class ResultRef(BaseModel):
    model_config = ConfigDict(frozen=True)
    result_set_id: str
    column: str
    row: int
    plan_hash: str
    semantic_model_version: int | None = None
    executed_at: str | None = None


class DerivedRef(BaseModel):
    model_config = ConfigDict(frozen=True)
    formula_id: FormulaId
    input_ids: tuple[str, ...]


class ConfigRef(BaseModel):
    model_config = ConfigDict(frozen=True)
    rule_id: str
    semantic_model_version: int


class Evidence(BaseModel):
    model_config = ConfigDict(frozen=True)
    id: str
    kind: Literal["result", "derived", "config"]
    value: float
    display: str
    unit: str | None = None
    result: ResultRef | None = None
    derived: DerivedRef | None = None
    config: ConfigRef | None = None


def _evidence_id(payload: object) -> str:
    # Content-addressed: the same origin always gets the same id (one record per number).
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    return f"ev_{digest[:8]}"


class EvidenceLedger:
    """Per-request ledger. Values are rendered once, in the tenant's number format."""

    def __init__(self, number_format: str = "indian") -> None:
        self._format = number_format
        self._items: dict[str, Evidence] = {}

    def __contains__(self, evidence_id: str) -> bool:
        return evidence_id in self._items

    def get(self, evidence_id: str) -> Evidence:
        return self._items[evidence_id]

    def items(self) -> list[Evidence]:
        return list(self._items.values())

    def _put(self, ev: Evidence) -> Evidence:
        return self._items.setdefault(ev.id, ev)

    def add_result(
        self, value: str | float | Decimal, unit: str | None, ref: ResultRef
    ) -> Evidence:
        v = Decimal(str(value))
        return self._put(
            Evidence(
                id=_evidence_id(["result", ref.model_dump(mode="json", exclude={"executed_at"})]),
                kind="result",
                value=float(v),
                display=format_number(v, unit, self._format),
                unit=unit,
                result=ref,
            )
        )

    def add_config(self, value: float, unit: str | None, ref: ConfigRef) -> Evidence:
        return self._put(
            Evidence(
                id=_evidence_id(["config", ref.model_dump(mode="json")]),
                kind="config",
                value=value,
                display=format_number(Decimal(str(value)), unit, self._format),
                unit=unit,
                config=ref,
            )
        )

    def add_derived(
        self, value: Decimal, unit: str | None, formula_id: FormulaId, input_ids: tuple[str, ...]
    ) -> Evidence:
        for i in input_ids:
            if i not in self._items:
                raise KeyError("derived value refers to an unknown evidence id")
        return self._put(
            Evidence(
                id=_evidence_id(["derived", formula_id, list(input_ids)]),
                kind="derived",
                value=float(value),
                display=format_number(value, unit, self._format),
                unit=unit,
                derived=DerivedRef(formula_id=formula_id, input_ids=input_ids),
            )
        )
