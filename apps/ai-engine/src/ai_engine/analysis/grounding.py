"""Rendering and the grounding check (D-22 option A).

The model writes `{{ev_xxxx}}` placeholders. Code renders them from the ledger. Literal digits in
the model's text are rejected unless they are part of a date, a year, a quarter or a fiscal-year
label, so a number can only reach the user through the ledger.
"""

import re

from pydantic import BaseModel

from ai_engine.analysis.evidence import EVIDENCE_ID, EvidenceLedger

_PLACEHOLDER = re.compile(r"\{\{\s*(ev_[a-z0-9]{4,16})\s*\}\}")
_ANY_BRACES = re.compile(r"\{\{.*?\}\}")
# Contexts where digits are allowed: ISO dates, years, quarters, fiscal-year labels.
_ALLOWED = re.compile(
    r"\b\d{4}-\d{2}-\d{2}\b|\bFY\s?\d{2,4}(?:-\d{2,4})?\b|\bQ[1-4]\b|\b(?:19|20)\d{2}\b"
)
_DIGITS = re.compile(r"\d")


class GroundingResult(BaseModel):
    ok: bool
    rendered: str
    problems: list[str]


def check_and_render(text: str, ledger: EvidenceLedger) -> GroundingResult:
    problems: list[str] = []
    for raw in _ANY_BRACES.findall(text):
        m = _PLACEHOLDER.fullmatch(raw)
        if m is None or not EVIDENCE_ID.match(m.group(1)):
            problems.append("malformed placeholder")
        elif m.group(1) not in ledger:
            problems.append("placeholder refers to unknown evidence")
    outside = _ALLOWED.sub(" ", _ANY_BRACES.sub(" ", text))
    if _DIGITS.search(outside):
        problems.append("literal number in text")
    if problems:
        return GroundingResult(ok=False, rendered="", problems=sorted(set(problems)))
    rendered = _PLACEHOLDER.sub(lambda m: ledger.get(m.group(1)).display, text)
    return GroundingResult(ok=True, rendered=rendered, problems=[])


def referenced_ids(text: str) -> list[str]:
    """Evidence ids a text refers to, in order, without repeats."""
    seen: dict[str, None] = {}
    for m in _PLACEHOLDER.finditer(text):
        seen.setdefault(m.group(1))
    return list(seen)
