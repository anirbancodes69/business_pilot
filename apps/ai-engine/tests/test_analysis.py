from decimal import Decimal

from ai_engine.analysis.calculations import (
    contribution_to_delta,
    pct_change,
    share_of_total,
)
from ai_engine.analysis.evidence import ConfigRef, EvidenceLedger, ResultRef
from ai_engine.analysis.formatting import format_number
from ai_engine.analysis.grounding import check_and_render, referenced_ids


def _ref(row: int, column: str = "m0") -> ResultRef:
    return ResultRef(result_set_id="rs1", column=column, row=row, plan_hash="abc")


def test_indian_grouping_and_words() -> None:
    assert format_number(1234567.5, "currency") == "₹12.35 lakh"
    assert format_number(125000000, "currency") == "₹12.50 crore"
    assert format_number(98765, "currency") == "₹98,765"
    assert format_number(-250000, "currency") == "-₹2.50 lakh"
    assert format_number(1234567, "quantity") == "12,34,567"
    assert format_number(1234567, "quantity", "international") == "1,234,567"
    assert format_number(12.345, "percent") == "12.3%"
    assert format_number(30, "days") == "30 days"


def test_result_evidence_is_deduplicated_and_content_addressed() -> None:
    ledger = EvidenceLedger()
    a = ledger.add_result("900.00", "currency", _ref(0))
    b = ledger.add_result("900.00", "currency", _ref(0))
    c = ledger.add_result("500.00", "currency", _ref(1))
    assert a.id == b.id and a.id != c.id
    assert len(ledger.items()) == 2


def test_calculations_use_decimals_and_refuse_division_by_zero() -> None:
    ledger = EvidenceLedger()
    cur = ledger.add_result("1500", "currency", _ref(0))
    prev = ledger.add_result("1200", "currency", _ref(1))
    zero = ledger.add_result("0", "currency", _ref(2))
    change = pct_change(ledger, cur, prev)
    assert change is not None and change.display == "25.0%"
    assert change.derived is not None and change.derived.input_ids == (cur.id, prev.id)
    assert pct_change(ledger, cur, zero) is None
    share = share_of_total(ledger, prev, cur)
    assert share is not None and Decimal(str(share.value)) == Decimal("80")
    assert contribution_to_delta(ledger, cur, zero) is None


def test_contribution_to_delta_can_exceed_one_hundred_percent() -> None:
    ledger = EvidenceLedger()
    member = ledger.add_result("-300", "currency", _ref(0))
    total = ledger.add_result("-200", "currency", _ref(1))
    c = contribution_to_delta(ledger, member, total)
    assert c is not None and c.display == "150.0%"


def test_placeholders_render_from_the_ledger() -> None:
    ledger = EvidenceLedger()
    ev = ledger.add_result("2500000", "currency", _ref(0))
    rule = ledger.add_config(
        90, "days", ConfigRef(rule_id="overdue_days", semantic_model_version=1)
    )
    text = (
        f"Overdue dues are {{{{{ev.id}}}}} for invoices older than "
        f"{{{{ {rule.id} }}}} in Q2 FY2026-27."
    )
    res = check_and_render(text, ledger)
    assert res.ok, res.problems
    assert (
        res.rendered
        == "Overdue dues are ₹25.00 lakh for invoices older than 90 days in Q2 FY2026-27."
    )
    assert referenced_ids(text) == [ev.id, rule.id]


def test_literal_numbers_and_bad_placeholders_are_rejected() -> None:
    ledger = EvidenceLedger()
    ev = ledger.add_result("10", "quantity", _ref(0))
    bad = check_and_render("Revenue grew 25% to 12 lakh", ledger)
    assert not bad.ok and "literal number in text" in bad.problems
    unknown = check_and_render("Value {{ev_deadbeef}}", ledger)
    assert unknown.problems == ["placeholder refers to unknown evidence"]
    assert check_and_render("Value {{oops}}", ledger).problems == ["malformed placeholder"]
    assert check_and_render(f"Fine {{{{{ev.id}}}}} on 2026-04-01", ledger).ok
    assert not check_and_render("Top 5 customers", ledger).ok


def test_evidence_model_matches_the_contract() -> None:
    import json
    from pathlib import Path

    from ai_engine.analysis.evidence import ConfigRef, DerivedRef, Evidence, ResultRef

    schema = json.loads(
        (Path(__file__).parents[3] / "contracts/ai/answer-response.schema.json").read_text()
    )
    ev = schema["properties"]["evidence"]["items"]
    assert schema["x-version"] == "0.2.0"
    assert set(ev["properties"]) == set(Evidence.model_fields)
    assert set(ev["properties"]["result"]["properties"]) == set(ResultRef.model_fields)
    assert set(ev["properties"]["derived"]["properties"]) == set(DerivedRef.model_fields)
    assert set(ev["properties"]["config"]["properties"]) == set(ConfigRef.model_fields)
