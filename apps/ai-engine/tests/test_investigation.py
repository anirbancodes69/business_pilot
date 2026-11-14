from decimal import Decimal
from typing import Any

import pytest

from ai_engine.answer.models import ToolResult
from ai_engine.answer.tools import ToolError
from ai_engine.investigation import engine
from ai_engine.investigation.engine import investigate
from ai_engine.planning.view import AuthorizedView

D = Decimal

VIEW = AuthorizedView.model_validate(
    {
        "semantic_model_version": 1,
        "tenant_settings": {},
        "measures": [
            {
                "id": "revenue",
                "entity": "invoice",
                "label": "Revenue",
                "unit": "currency",
                "additivity": "additive",
                "default_time_dimension": "invoice.invoice_date",
                "valid_dimensions": ["branch.name", "customer.name", "customer.segment"],
                "breakdown_measure": "line_revenue",
            },
            {
                "id": "line_revenue",
                "entity": "invoice_line",
                "label": "Line revenue",
                "unit": "currency",
                "additivity": "additive",
                "default_time_dimension": "invoice.invoice_date",
            },
            {
                "id": "average_order_value",
                "entity": "invoice",
                "label": "Average order value",
                "unit": "currency",
                "additivity": "non_additive",
            },
        ],
        "dimensions": [
            {
                "id": "branch.state",
                "label": "State",
                "type": "categorical",
                "diagnostic": True,
                "hierarchy": {"name": "geography", "level": 1},
            },
            {
                "id": "branch.name",
                "label": "Branch",
                "type": "categorical",
                "diagnostic": True,
                "hierarchy": {"name": "geography", "level": 2},
            },
            {"id": "customer.name", "label": "Customer", "type": "categorical", "diagnostic": True},
            {
                "id": "customer.segment",
                "label": "Segment",
                "type": "categorical",
                "diagnostic": True,
            },
            {
                "id": "product.category",
                "label": "Category",
                "type": "categorical",
                "diagnostic": True,
                "hierarchy": {"name": "product", "level": 1},
            },
            {
                "id": "product.sub_category",
                "label": "Sub-category",
                "type": "categorical",
                "diagnostic": True,
                "hierarchy": {"name": "product", "level": 2},
            },
            {"id": "product.brand", "label": "Brand", "type": "categorical", "diagnostic": True},
            {"id": "invoice.invoice_date", "label": "Invoice date", "type": "time"},
        ],
    }
)

FIELD = {
    "branch.name": "branch",
    "branch.state": "state",
    "customer.name": "customer",
    "customer.segment": "segment",
    "product.sub_category": "sub",
    "product.category": "sub",
    "product.brand": "brand",
}


def fact(
    period: str, branch: str, sub: str, customer: str, value: int, segment: str = "retail"
) -> dict[str, Any]:
    return {
        "period": period,
        "branch": branch,
        "state": "MH",
        "sub": sub,
        "brand": f"b-{sub}",
        "customer": customer,
        "segment": segment,
        "value": value,
    }


def world(snack_drop: int = 100_000) -> list[dict[str, Any]]:
    rows = []
    for br in ("Pune", "Nashik", "Nagpur"):
        for sub in ("Snacks", "Beverages"):
            for cust in (f"{br}-A", f"{br}-B"):
                base = 50_000
                rows.append(fact("prev", br, sub, cust, base))
                drop = snack_drop // 2 if (br, sub) == ("Nashik", "Snacks") else 0
                rows.append(fact("cur", br, sub, cust, base - drop))
    return rows


class FakeApi:
    def __init__(self, facts: list[dict[str, Any]], refuse: set[str] | None = None) -> None:
        self.facts, self.refuse = facts, refuse or set()
        self.plans: list[dict[str, Any]] = []

    def __call__(self, plan: dict[str, Any]) -> ToolResult:
        self.plans.append(plan)
        measure = plan["measures"][0]
        dims = [d["id"] for d in plan.get("dimensions", [])]
        if any(d in self.refuse for d in dims):
            raise ToolError("not_authorized")
        # like the real compiler: revenue has no product dimensions
        if measure == "revenue" and any(d.startswith("product.") for d in dims):
            raise ToolError("invalid_plan")
        want = {f["dimension"]: f["values"][0] for f in plan.get("filters", [])}

        def cut(period: str) -> dict[str, Any]:
            groups: dict[tuple[str, ...], int] = {}
            for f in self.facts:
                if f["period"] != period:
                    continue
                if any(f[FIELD[k]] != v for k, v in want.items()):
                    continue
                key = tuple(f[FIELD[d]] for d in dims)
                groups[key] = groups.get(key, 0) + f["value"]
            cols: list[dict[str, Any]] = [
                {"name": f"d{i}", "semantic_id": d, "kind": "dimension", "type": "categorical"}
                for i, d in enumerate(dims)
            ]
            cols.append(
                {
                    "name": "m0",
                    "semantic_id": measure,
                    "kind": "measure",
                    "type": "numeric",
                    "unit": "currency",
                }
            )
            rows = (
                [[*k, f"{v}.00"] for k, v in sorted(groups.items())]
                if dims
                else [[f"{sum(groups.values())}.00"]]
                if groups
                else []
            )
            return {"columns": cols, "rows": rows, "row_count": len(rows), "truncated": False}

        return ToolResult.model_validate(
            {
                "plan_hash": "h" * 64,
                "semantic_model_version": 1,
                "data_executed_at": "2026-11-15T04:30:00Z",
                "result_sets": [
                    {"id": "cur", "role": "current", **cut("cur")},
                    {"id": "prev", "role": "comparison", **cut("prev")},
                ],
            }
        )


BASE = {
    "plan_version": "0.1",
    "semantic_model_version": 1,
    "intent": "diagnostic",
    "measures": ["revenue"],
    "time_range": {"start": "2026-10-01", "end": "2026-10-31"},
    "comparison": {
        "type": "previous_period",
        "time_range": {"start": "2026-09-01", "end": "2026-09-30"},
    },
    "sort": [{"by": "revenue", "direction": "desc"}],
}


def test_finds_the_branch_then_the_category_within_the_budget() -> None:
    api = FakeApi(world())
    inv = investigate(BASE, VIEW, api)
    assert inv.stop == "dominant_driver" and inv.calls <= engine.MAX_CALLS
    assert inv.total is not None and inv.total.total_delta == D(-100_000)
    first = inv.drivers[0]
    assert (first.depth, first.member.label, first.share) == (1, "Nashik", D(1))
    second = next(d for d in inv.drivers if d.depth == 2)
    assert (second.member.label, second.parent_label) == ("Snacks", "Nashik")
    assert second.share == D(1) and second.step.measure == "line_revenue"
    assert inv.used_breakdown_measure is True


def test_each_step_is_a_closed_catalog_plan_with_the_filter_carried_down() -> None:
    api = FakeApi(world())
    investigate(BASE, VIEW, api)
    assert api.plans[0].get("dimensions") is None  # the total
    drill = [p for p in api.plans if p.get("filters")]
    assert drill and all(
        p["filters"] == [{"dimension": "branch.name", "operator": "eq", "values": ["Nashik"]}]
        for p in drill
    )
    for p in api.plans:
        assert (
            p["intent"] == "diagnostic"
            and "sort" not in p
            and p["comparison"]["type"] == "previous_period"
        )
        assert len(p["measures"]) == 1 and len(p.get("dimensions", [])) <= 1


def test_the_call_budget_is_a_hard_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(engine, "MAX_CALLS", 3)
    api = FakeApi(world())
    inv = investigate(BASE, VIEW, api)
    assert inv.calls == 3 == len(api.plans)
    assert [p.get("dimensions") for p in api.plans][0] is None


def test_default_budget_is_six_calls() -> None:
    api = FakeApi(world())
    investigate(BASE, VIEW, api)
    assert len(api.plans) <= 6


def test_no_change_stops_after_one_call() -> None:
    api = FakeApi(world(snack_drop=0))
    inv = investigate(BASE, VIEW, api)
    assert inv.stop == "no_change" and inv.calls == 1 and inv.drivers == []


def test_a_change_spread_evenly_has_no_dominant_driver() -> None:
    rows = [
        fact(p, br, "Snacks", f"{br}-{i}", 50_000 - (0 if p == "prev" else 5_000))
        for p in ("prev", "cur")
        for br in ("Pune", "Nashik", "Nagpur", "Surat")
        for i in range(2)
    ]
    inv = investigate(BASE, VIEW, FakeApi(rows))
    assert inv.stop == "spread"
    assert all(abs(d.share) < D("0.30") for d in inv.drivers)


def test_a_refused_breakdown_ends_that_branch_and_is_reported() -> None:
    api = FakeApi(world(), refuse={"customer.name"})
    inv = investigate(BASE, VIEW, api)
    assert "Some breakdowns were not available for your access." in inv.unknowns
    assert inv.drivers and inv.drivers[0].member.label == "Nashik"
    # never retried with another scope: the refused dimension was asked for exactly once
    assert sum(1 for p in api.plans if p.get("dimensions") == [{"id": "customer.name"}]) == 1


def test_a_refused_first_step_is_raised_to_the_caller() -> None:
    def deny(plan: dict[str, Any]) -> ToolResult:
        raise ToolError("not_authorized")

    with pytest.raises(ToolError):
        investigate(BASE, VIEW, deny)


def test_non_additive_measures_are_not_investigated() -> None:
    api = FakeApi(world())
    inv = investigate({**BASE, "measures": ["average_order_value"]}, VIEW, api)
    assert inv.stop == "unsupported" and api.plans == []


def test_a_period_without_data_is_reported() -> None:
    inv = investigate(BASE, VIEW, FakeApi([f for f in world() if f["period"] == "cur"]))
    assert inv.stop == "no_data" and inv.calls == 1


def test_shares_use_the_direction_of_the_total_change() -> None:
    rows = world()
    # an offsetting rise elsewhere: Pune up 30k while Nashik is down 100k
    for r in rows:
        if r["period"] == "cur" and r["branch"] == "Pune" and r["sub"] == "Beverages":
            r["value"] += 15_000
    inv = investigate(BASE, VIEW, FakeApi(rows))
    assert inv.total is not None and inv.total.total_delta == D(-70_000)
    top = inv.drivers[0]
    assert top.member.label == "Nashik" and top.share == D(100_000) / D(70_000)  # more than 100%
