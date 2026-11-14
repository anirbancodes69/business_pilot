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
    assert len(results) >= 55 and pending == 2
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
        "followup",
        "example",
    } <= cats
    # nothing needed a repair; a follow-up case plans its first turn and classifies its second
    assert all(r.llm_calls == (2 if r.category == "followup" else 1) for r in results)


def test_pending_cases_are_declared_not_silently_dropped() -> None:
    suite = load_suite()
    pending = [c for c in suite.cases if c.status == "pending"]
    assert {c.category for c in pending} == {"diagnostic"}
    assert all(c.needs for c in pending)


def test_every_case_has_a_unique_id_and_what_it_needs() -> None:
    suite = load_suite()
    ids = [c.id for c in suite.cases]
    assert len(ids) == len(set(ids))
    for c in suite.cases:
        if c.status == "active":
            assert c.question or c.turns, c.id
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


def test_the_token_cap_stops_new_cases() -> None:
    from ai_engine.evaluation.golden import Case as _Case  # noqa: F401

    suite = load_suite()
    ok = {
        "outcome": "plan",
        "plan": {
            "intent": "metric",
            "measures": ["revenue"],
            "time_range": {"relative": "last_month"},
        },
    }
    # Scripted costs 120 tokens per call. A cap of 200 allows two cases (the second starts at 120).
    model = Scripted(*([ok] * 10))
    results, _ = run(
        suite, model, only={"met-001", "met-002", "met-003", "met-004", "met-005"}, max_tokens=200
    )
    assert len(results) == 2 and len(model.requests) <= 4


def test_an_accepted_alternative_counts_as_correct() -> None:
    now = datetime.fromisoformat(load_suite().as_of)
    case = next(c for c in load_suite().cases if c.id == "flt-005")
    base = {
        "intent": "ranking",
        "measures": ["outstanding_receivables"],
        "dimensions": [{"id": "customer.name"}],
        "time_range": {"relative": "last_n_days", "n": 730},
        "sort": [{"by": "outstanding_receivables", "direction": "desc"}],
    }
    by_city = {
        "outcome": "plan",
        "plan": {
            **base,
            "filters": [{"dimension": "customer.city", "operator": "eq", "values": ["Nagpur"]}],
        },
    }
    by_branch = {
        "outcome": "plan",
        "plan": {
            **base,
            "filters": [{"dimension": "branch.name", "operator": "eq", "values": ["Nagpur"]}],
        },
    }
    wrong = {
        "outcome": "plan",
        "plan": {
            **base,
            "filters": [{"dimension": "customer.city", "operator": "eq", "values": ["Pune"]}],
        },
    }
    assert evaluate_case(case, now, Scripted(by_city)).ok
    assert evaluate_case(case, now, Scripted(by_branch)).ok
    assert not evaluate_case(case, now, Scripted(wrong)).ok


def test_a_named_safe_outcome_counts_as_correct() -> None:
    now = datetime.fromisoformat(load_suite().as_of)
    case = next(c for c in load_suite().cases if c.id == "adv-001")
    assert evaluate_case(
        case, now, Scripted({"outcome": "clarify", "clarification_question": "?"})
    ).ok
    assert not evaluate_case(case, now, Scripted({"outcome": "out_of_scope"})).ok


def test_follow_up_cases_are_scored_on_the_change_and_the_resulting_plan() -> None:
    now = datetime.fromisoformat(load_suite().as_of)
    case = next(c for c in load_suite().cases if c.id == "fu-001")
    first = {
        "outcome": "plan",
        "plan": {
            "intent": "ranking",
            "measures": ["revenue"],
            "dimensions": [{"id": "branch.name"}],
            "time_range": {"relative": "last_month"},
        },
    }
    right = {"delta": {"type": "refine_filter", "dimension": "branch.name", "values": ["Nashik"]}}
    wrong = {"delta": {"type": "refine_filter", "dimension": "branch.name", "values": ["Pune"]}}
    other = {"delta": {"type": "top_n", "limit": 3}}
    assert evaluate_case(case, now, Scripted(first, right)).ok
    bad = evaluate_case(case, now, Scripted(first, wrong))
    assert not bad.ok and any("delta values" in p for p in bad.problems)
    assert not evaluate_case(case, now, Scripted(first, other)).ok
    assert not evaluate_case(case, now, Scripted(first, {"delta": {"type": "new_question"}})).ok


def test_a_follow_up_that_is_really_a_new_question_must_not_be_applied() -> None:
    now = datetime.fromisoformat(load_suite().as_of)
    case = next(c for c in load_suite().cases if c.id == "fu-007")
    first = {
        "outcome": "plan",
        "plan": {
            "intent": "metric",
            "measures": ["revenue"],
            "time_range": {"relative": "last_month"},
        },
    }
    assert evaluate_case(case, now, Scripted(first, {"delta": {"type": "new_question"}})).ok
    applied = {"delta": {"type": "change_metric", "measures": ["outstanding_receivables"]}}
    assert not evaluate_case(case, now, Scripted(first, applied)).ok
