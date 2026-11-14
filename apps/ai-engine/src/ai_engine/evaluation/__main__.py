"""Command line: planner evaluation over the golden set.

uv run python -m ai_engine.evaluation                      replay mode: free, checks the golden set
uv run python -m ai_engine.evaluation --real               shows the estimated cost and stops
uv run python -m ai_engine.evaluation --real --yes         calls the configured model (costs money)
options: --only met-001,rank-002   --limit 10   --out report.json
"""

import argparse
import json
import sys
from pathlib import Path

from ai_engine.evaluation.golden import load_suite, summarize
from ai_engine.evaluation.runner import ReplayProvider, run
from ai_engine.llm import create_llm_provider
from ai_engine.planning.planner import plan_question  # noqa: F401  (import check)

# Rough size of one planner call with the owner catalog (measured: about 1,200 tokens in, 250 out).
EST_IN, EST_OUT = 1300, 300


def main() -> int:
    ap = argparse.ArgumentParser(prog="ai_engine.evaluation")
    ap.add_argument("--real", action="store_true", help="use the configured model (costs money)")
    ap.add_argument("--yes", action="store_true", help="confirm that real calls may be made")
    ap.add_argument("--only", help="comma-separated case ids")
    ap.add_argument("--limit", type=int)
    ap.add_argument(
        "--max-tokens",
        type=int,
        default=120_000,
        help="stop starting new cases after this many tokens",
    )
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    suite = load_suite()
    only = set(args.only.split(",")) if args.only else None
    active = [c for c in suite.cases if c.status == "active" and (not only or c.id in only)]
    if args.limit:
        active = active[: args.limit]

    if args.real:
        calls = len(active) * 2  # at most one repair each
        print(
            f"{len(active)} cases, up to {calls} planner calls "
            f"(about {len(active) * EST_IN:,} input and {len(active) * EST_OUT:,} output tokens "
            "without repairs)."
        )
        if not args.yes:
            print("Nothing was sent. Add --yes to run it.")
            return 0
        provider = create_llm_provider("openai")
    else:
        provider = ReplayProvider()

    results, pending = run(
        suite, provider, only, args.limit, args.max_tokens if args.real else None
    )
    s = summarize(results, pending)
    mode = "REAL MODEL" if args.real else "replay (no model)"
    print(f"\nGolden set {suite.suite} · {mode}")
    for cat, (ok, total) in s.by_category.items():
        print(f"  {cat:<14}{ok}/{total}")
    acc = f"{s.plan_accuracy:.0%}" if s.plan_accuracy is not None else "n/a"
    print(f"  plan accuracy {acc} ({s.passed}/{s.total}) · pending cases: {s.pending}")
    if s.intent_accuracy is not None:
        print(f"  intent accuracy {s.intent_accuracy:.0%}")
    print(f"  model calls {s.llm_calls} · tokens in {s.input_tokens:,} out {s.output_tokens:,}")
    if s.total < len(active):
        print(f"  STOPPED by the token cap after {s.total} of {len(active)} cases")
    for r in results:
        if not r.ok:
            print(f"  FAIL {r.id}: {'; '.join(r.problems)[:240]}")
            if r.clarification:
                print(f"       asked: {r.clarification}")
            if r.actual_plan:
                p = r.actual_plan
                print(
                    f"       got: intent={p.get('intent')} measures={p.get('measures')} "
                    f"dims={[d['id'] for d in p.get('dimensions', [])]} "
                    f"filters={p.get('filters')} range={p.get('time_range')}"
                )
    for r in results:
        if r.repaired_from:
            print(f"  REPAIRED {r.id}: {'; '.join(r.repaired_from)[:200]}")
    if args.out:
        args.out.write_text(
            json.dumps(
                {"summary": s.model_dump(), "results": [r.model_dump() for r in results]}, indent=1
            ),
            encoding="utf-8",
        )
    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
