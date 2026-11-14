"""The answer flow: plan -> execute through the api -> explain -> ground -> respond.

Every number in the response comes from the evidence ledger. If the explainer cannot produce text
that passes the grounding check, the answer is degraded to facts written by code.
"""

import time
from typing import Any

from ai_engine.analysis.calculations import abs_change, pct_change
from ai_engine.analysis.evidence import Evidence, EvidenceLedger, ResultRef
from ai_engine.analysis.grounding import referenced_ids
from ai_engine.answer import explainer
from ai_engine.answer.models import (
    AnswerRequest,
    AnswerResponse,
    ToolColumn,
    ToolResult,
    ToolResultSet,
)
from ai_engine.answer.tools import DataTools, ToolError
from ai_engine.llm import LlmProvider
from ai_engine.planning import prompts as planner_prompts
from ai_engine.planning.planner import PlannerOutcome, plan_question

MAX_ROWS = 50
PREVIEW_FACTS = 5


def _unavailable(
    request_id: str, intent: str, status: str, summary: str, **extra: Any
) -> dict[str, Any]:
    return {
        "request_id": request_id,
        "status": status,
        "intent": intent,
        "summary": summary,
        "execution": {
            "plan_hashes": [],
            "semantic_model_version": 0,
            "grounding": "not_applicable",
            "tool_calls": 0,
            "prompt_versions": {"planner": planner_prompts.PROMPT_VERSION},
            "model_ids": [],
        },
        **extra,
    }


def _context(req: AnswerRequest, outcome: PlannerOutcome, refs: list[str]) -> dict[str, Any]:
    raw = outcome.raw_plan
    previous = (req.analytical_context or {}).get("turn", 0)
    focus: dict[str, Any] = {}
    if raw is not None:
        focus = {
            "metrics": raw.measures,
            "dimensions": [d.id for d in raw.dimensions],
            "filters": [f.model_dump() for f in raw.filters],
            "time_range": raw.time_range.model_dump(exclude_none=True),
        }
        if raw.comparison:
            focus["comparison"] = raw.comparison.model_dump(exclude_none=True)
    ctx: dict[str, Any] = {
        "semantic_model_version": req.authorized_view.semantic_model_version,
        "turn": int(previous) + 1 if isinstance(previous, int) else 1,
        "last_analysis_type": raw.intent if raw else "clarify",
        "open_hypotheses": [],
        "evidence_refs": refs[:50],
    }
    if focus:
        ctx["focus"] = focus
    return ctx


def _build_evidence(
    result: ToolResult, ledger: EvidenceLedger
) -> tuple[list[dict[str, Any]], dict[str, dict[str, str]]]:
    """Result sets as the explainer sees them (numbers replaced by evidence ids)."""
    shown: list[dict[str, Any]] = []
    first_ref: dict[str, dict[str, str]] = {}
    for rs in result.result_sets:
        rows_out: list[dict[str, Any]] = []
        for i, row in enumerate(rs.rows[:MAX_ROWS]):
            cells: dict[str, Any] = {}
            for col, value in zip(rs.columns, row, strict=False):
                if col.kind == "dimension" or value is None:
                    cells[col.semantic_id] = value
                    continue
                ev = ledger.add_result(
                    value,
                    col.unit,
                    ResultRef(
                        result_set_id=rs.id,
                        column=col.semantic_id,
                        row=i,
                        plan_hash=result.plan_hash,
                        semantic_model_version=result.semantic_model_version,
                        executed_at=result.data_executed_at,
                    ),
                )
                cells[col.semantic_id] = {"ref": ev.id, "shown": ev.display}
            rows_out.append(cells)
        shown.append({"id": rs.id, "period": rs.role, "rows": rows_out})
    return shown, first_ref


def _tables(
    result: ToolResult, ledger: EvidenceLedger, view_labels: dict[str, str]
) -> list[dict[str, Any]]:
    """Result tables for the UI. Every number is the ledger's rendered text; nothing is formatted
    by the UI."""
    tables: list[dict[str, Any]] = []
    for rs in result.result_sets:
        rows: list[list[str | None]] = []
        for i, row in enumerate(rs.rows[:MAX_ROWS]):
            cells: list[str | None] = []
            for col, value in zip(rs.columns, row, strict=False):
                if value is None:
                    cells.append(None)
                elif col.kind == "dimension":
                    cells.append(str(value))
                else:
                    cells.append(_cell(ledger, result, rs, col, i, value).display)
            rows.append(cells)
        tables.append(
            {
                "result_set_id": rs.id,
                "title": "Current period" if rs.role == "current" else "Comparison period",
                "period": rs.role,
                "as_of": result.data_executed_at,
                "truncated": rs.truncated or rs.row_count > MAX_ROWS,
                "columns": [
                    {
                        "semantic_id": c.semantic_id,
                        "label": view_labels.get(c.semantic_id, c.semantic_id),
                        "kind": c.kind,
                    }
                    for c in rs.columns
                ],
                "rows": rows,
            }
        )
    return tables


def _cell(
    ledger: EvidenceLedger,
    result: ToolResult,
    rs: ToolResultSet,
    col: ToolColumn,
    row: int,
    value: Any,
) -> Evidence:
    return ledger.add_result(
        value,
        col.unit,
        ResultRef(
            result_set_id=rs.id,
            column=col.semantic_id,
            row=row,
            plan_hash=result.plan_hash,
            semantic_model_version=result.semantic_model_version,
            executed_at=result.data_executed_at,
        ),
    )


def _derived(
    result: ToolResult, ledger: EvidenceLedger, labels: dict[str, str]
) -> list[tuple[str, Evidence]]:
    """Change and percent change for a plain current-versus-comparison answer (no grouping)."""
    by_role: dict[str, ToolResultSet] = {rs.role: rs for rs in result.result_sets}
    cur, prev = by_role.get("current"), by_role.get("comparison")
    out: list[tuple[str, Evidence]] = []
    if not cur or not prev or cur.row_count != 1 or prev.row_count != 1:
        return out
    if any(c.kind == "dimension" for c in cur.columns):
        return out
    for i, col in enumerate(cur.columns):
        a, b = cur.rows[0][i], prev.rows[0][i]
        if a is None or b is None:
            continue
        ec = _cell(ledger, result, cur, col, 0, a)
        ep = _cell(ledger, result, prev, col, 0, b)
        name = labels.get(col.semantic_id, col.semantic_id)
        out.append((f"Change in {name}", abs_change(ledger, ec, ep)))
        pct = pct_change(ledger, ec, ep)
        if pct is not None:
            out.append((f"Percent change in {name}", pct))
    return out


def _degraded_facts(result: ToolResult, ledger: EvidenceLedger) -> list[dict[str, Any]]:
    """Facts written by code alone, for when the explainer's text cannot be trusted."""
    facts: list[dict[str, Any]] = []
    rs = next((r for r in result.result_sets if r.role == "current"), None)
    if rs is None:
        return facts
    for i, row in enumerate(rs.rows[:PREVIEW_FACTS]):
        parts: list[str] = []
        ids: list[str] = []
        for col, value in zip(rs.columns, row, strict=False):
            if value is None:
                continue
            if col.kind == "dimension":
                parts.append(str(value))
                continue
            ev = ledger.add_result(
                value,
                col.unit,
                ResultRef(
                    result_set_id=rs.id,
                    column=col.semantic_id,
                    row=i,
                    plan_hash=result.plan_hash,
                    semantic_model_version=result.semantic_model_version,
                    executed_at=result.data_executed_at,
                ),
            )
            ids.append(ev.id)
            parts.append(ev.display)
        if parts:
            facts.append(
                {"statement": ": ".join(parts), "result_set_id": rs.id, "evidence_ids": ids}
            )
    return facts


def answer_question(
    req: AnswerRequest, request_id: str, provider: LlmProvider, tools: DataTools
) -> AnswerResponse:
    started = time.monotonic()
    view = req.authorized_view
    outcome = plan_question(req.question, view, req.resolved_now, provider)
    versions = {"planner": planner_prompts.PROMPT_VERSION}
    explained: list[explainer.Explained] = []

    def finish(d: dict[str, Any]) -> AnswerResponse:
        d["execution"]["model_ids"] = outcome.models + d["execution"].get("model_ids", [])
        ex = explained[0] if explained else None
        d["execution"]["usage"] = {
            "planner": {
                "calls": outcome.llm_calls,
                "input_tokens": outcome.input_tokens,
                "output_tokens": outcome.output_tokens,
            },
            "explainer": {
                "calls": ex.llm_calls if ex else 0,
                "input_tokens": ex.input_tokens if ex else 0,
                "output_tokens": ex.output_tokens if ex else 0,
            },
        }
        d["execution"]["duration_ms"] = int((time.monotonic() - started) * 1000)
        d["analytical_context"] = d.get("analytical_context") or _context(req, outcome, [])
        return AnswerResponse.model_validate(d)

    if outcome.kind == "clarify":
        return finish(
            _unavailable(
                request_id,
                "clarify",
                "clarification_needed",
                "I need a little more detail to answer that.",
                clarification_question=outcome.clarification_question,
            )
        )
    if outcome.kind == "out_of_scope":
        return finish(
            _unavailable(
                request_id,
                "out_of_scope",
                "out_of_scope",
                "That question is not something I can answer from your business data.",
            )
        )
    if outcome.kind != "plan" or outcome.plan is None:
        return finish(
            _unavailable(
                request_id,
                "unknown",
                "failed",
                "I could not turn that question into a query.",
                unknowns=["The question could not be planned. Try rephrasing it."],
            )
        )

    plan = outcome.plan
    intent = str(plan["intent"])
    try:
        result = tools.execute_plan(req.request_context, request_id, plan)
    except ToolError as e:
        if e.kind == "not_authorized":
            return finish(
                _unavailable(
                    request_id,
                    intent,
                    "not_authorized",
                    "That is not available for your access.",
                    unknowns=["Some of the data you asked about is not available for your access."],
                )
            )
        text = {
            "timeout": "The query took too long.",
            "rate_limited": "Too many requests right now. Please try again shortly.",
        }.get(e.kind, "The query could not be run.")
        return finish(_unavailable(request_id, intent, "failed", text, unknowns=[text]))

    ledger = EvidenceLedger(view.tenant_settings.number_format or "indian")
    execution: dict[str, Any] = {
        "plan_hashes": [result.plan_hash],
        "semantic_model_version": result.semantic_model_version,
        "grounding": "not_applicable",
        "tool_calls": 1,
        "prompt_versions": versions,
        "model_ids": [],
    }
    base: dict[str, Any] = {
        "request_id": request_id,
        "intent": intent,
        "tables": _tables(
            result,
            ledger,
            {
                **{m.id: m.label for m in view.measures},
                **{d.id: d.label for d in view.dimensions},
            },
        ),
        "sources": result.sources,
        "freshness": result.freshness,
        "execution": execution,
    }
    notes: list[str] = []  # truncation is reported by code (unknowns), not by the model

    # Nothing matched: answer from code with no model call (saves cost; nothing to explain).
    if all(rs.row_count == 0 for rs in result.result_sets):
        return finish(
            {
                **base,
                "status": "answered",
                "summary": "No data matched that question for the period.",
                "unknowns": ["No rows matched the question and period."],
            }
        )

    data, _ = _build_evidence(result, ledger)
    labels = {m.id: m.label for m in view.measures}
    derived = _derived(result, ledger, labels)
    versions["explainer"] = explainer.PROMPT_VERSION
    ex = explainer.explain(
        req.question,
        data,
        derived,
        notes,
        {rs.id for rs in result.result_sets},
        ledger,
        provider,
    )
    explained.append(ex)
    execution["model_ids"] = ex.models
    unknowns = list(ex.reply.unknowns) if ex.reply else []
    if result.truncated:
        unknowns.append("Only the first rows are shown; there are more.")

    if ex.ok and ex.reply is not None:
        execution["grounding"] = "passed" if ex.llm_calls == 1 else "passed_after_regeneration"
        facts = [
            {
                "statement": ex.rendered[f"verified_facts.{i}"],
                "result_set_id": f.result_set_id,
                "evidence_ids": referenced_ids(f.statement),
            }
            for i, f in enumerate(ex.reply.verified_facts)
        ]
        hypotheses = [
            {
                "text": ex.rendered[f"possible_explanations.{i}"],
                "evidence_ids": referenced_ids(h.text),
            }
            for i, h in enumerate(ex.reply.possible_explanations)
        ]
        summary, status = ex.rendered["summary"], "answered"
    else:
        execution["grounding"] = "failed_degraded"
        facts = _degraded_facts(result, ledger)
        hypotheses = []
        summary, status = "Here are the results from your data.", "answered_facts_only"
        unknowns.append("A written explanation was not available for this answer.")

    refs = [ev.id for ev in ledger.items()]
    return finish(
        {
            **base,
            "status": status,
            "summary": summary,
            "verified_facts": facts,
            "derived_calculations": [
                {"label": label, "evidence_id": ev.id} for label, ev in derived
            ],
            "possible_explanations": hypotheses,
            "unknowns": unknowns,
            "evidence": [e.model_dump(mode="json", exclude_none=True) for e in ledger.items()],
            "analytical_context": _context(req, outcome, refs),
        }
    )
