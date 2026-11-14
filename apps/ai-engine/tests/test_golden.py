from datetime import datetime

from fakes import Scripted

from ai_engine.evaluation.golden import Case, load_suite, match_plan, summarize
from ai_engine.evaluation.runner import ReplayProvider, evaluate_case, run


def test_the_golden_set_is_valid_for_every_persona_view() -> None:
    """Free check of the set itself: replaying every expected plan must pass the planner's own
    validation against the persona's authorized view, and match field by field."""
    suite = load_suite()
    results, pending = run(suite, ReplayProvider())
    failed = {r.id: r.problems for r in results if not r.ok}
    assert failed == {}
    assert len(results) >= 40 and pending == 5
    cats = {r.category for r in results}
    assert {
        "metric",
        "ranking",
        "comparison",
        "trend",
        "filter",
        "clarify",
        "out_of_scope",
        "adversarial",
    } <= cats
    assert all(r.llm_calls == 1 for r in results)  # nothing needed a repair


def test_pending_cases_are_declared_not_silently_dropped() -> None:
    suite = load_suite()
    pending = [c for c in suite.cases if c.status == "pending"]
    assert {c.category for c in pending} == {"diagnostic", "followup"}
    assert all(c.needs for c in pending)


def test_every_case_has_a_unique_id_and_what_it_needs() -> None:
    suite = load_suite()
    ids = [c.id for c in suite.cases]
    assert len(ids) == len(set(ids))
    for c in suite.cases:
        if c.status == "active":
            assert c.question
            assert c.expected != "plan" or c.expected_plan, c.id


EXPECTED = {
    "measures": ["revenue"],
    "dimensions": [{"id": "branch.name"}],
    "filters": [{"dimension": "branch.name", "operator": "eq", "values": ["Pune"]}],
    "time_range": {"start": "2026-10-01", "end": "2026-10-31"},
    "sort": {"by": "revenue", "direction": "desc"},
    "limit": 5,
}


def _actual(**over: object) -> dict[str, object]:
    plan: dict[str, object] = {
        "measures": ["revenue"],
        "dimensions": [{"id": "branch.name"}],
        "filters": [{"dimension": "branch.name", "operator": "in", "values": ["Pune"]}],
        "time_range": {"start": "2026-10-01", "end": "2026-10-31"},
        "sort": [{"by": "revenue", "direction": "desc"}],
        "limit": 5,
    }
    plan.update(over)
    return plan


def test_match_plan_accepts_equivalent_plans_and_names_each_difference() -> None:
    assert match_plan(EXPECTED, _actual()) == []  # in-with-one-value equals eq
    assert any("measures" in p for p in match_plan(EXPECTED, _actual(measures=["units_sold"])))
    assert any("dimensions" in p for p in match_plan(EXPECTED, _actual(dimensions=[])))
    assert "filters differ" in match_plan(EXPECTED, _actual(filters=[]))
    assert any(
        "time_range" in p
        for p in match_plan(
            EXPECTED, _actual(time_range={"start": "2026-09-01", "end": "2026-10-31"})
        )
    )
    assert "sort differs" in match_plan(
        EXPECTED, _actual(sort=[{"by": "revenue", "direction": "asc"}])
    )
    assert any("limit" in p for p in match_plan(EXPECTED, _actual(limit=10)))


def test_only_what_a_case_states_is_compared() -> None:
    loose = {"measures": ["outstanding_receivables"]}
    anything = {
        "measures": ["outstanding_receivables"],
        "time_range": {"start": "2020-01-01", "end": "2021-01-01"},
        "limit": 3,
    }
    assert match_plan(loose, anything) == []


def test_a_wrong_model_is_scored_wrong_and_costs_are_counted() -> None:
    now = datetime.fromisoformat(load_suite().as_of)
    case = next(c for c in load_suite().cases if c.id == "met-001")
    wrong = {
        "outcome": "plan",
        "plan": {
            "intent": "metric",
            "measures": ["invoice_count"],
            "time_range": {"relative": "last_month"},
        },
    }
    r = evaluate_case(case, now, Scripted(wrong))
    assert not r.ok and r.intent_ok is True and r.input_tokens == 100 and r.llm_calls == 1
    good = {
        "outcome": "plan",
        "plan": {
            "intent": "metric",
            "measures": ["revenue"],
            "time_range": {"relative": "last_month"},
        },
    }
    assert evaluate_case(case, now, Scripted(good)).ok


def test_refusal_cases_pass_only_without_a_plan() -> None:
    now = datetime.fromisoformat(load_suite().as_of)
    oos = Case.model_validate(
        {"id": "x", "category": "out_of_scope", "question": "weather?", "expected": "out_of_scope"}
    )
    assert evaluate_case(oos, now, Scripted({"outcome": "out_of_scope"})).ok
    plan = {
        "outcome": "plan",
        "plan": {
            "intent": "metric",
            "measures": ["revenue"],
            "time_range": {"relative": "last_month"},
        },
    }
    assert not evaluate_case(oos, now, Scripted(plan)).ok


def test_summary_counts_by_category() -> None:
    results, pending = run(load_suite(), ReplayProvider(), only={"met-001", "met-002", "clr-001"})
    s = summarize(results, pending)
    assert s.by_category["metric"] == (2, 2) and s.by_category["clarify"] == (1, 1)
    assert s.plan_accuracy == 1.0
