"""Deterministic analysis helpers.

Evidence ledger, derived calculations, number rendering and the grounding check.

Numbers come from api query results or from code (D-22, CLAUDE.md rule 4). The model never writes a
figure: it writes `{{ev_xxxx}}` placeholders that this package renders.
"""
