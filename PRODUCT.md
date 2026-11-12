# PRODUCT.md — Product definition

## Vision

Every business, however small, has an analyst that knows its numbers, investigates what changed and explains why, with evidence it can check.

## Mission

Give the people who run SMEs answers to their business questions that come with evidence. Each answer says what happened, where and why, and what to look at next. Every number traces to the business's own data, and every answer respects who is allowed to see what. No data team, BI rollout or re-platforming project is needed.

## Positioning

BusinessPilot is an **AI Business Analyst**: a configuration-driven, multi-tenant business intelligence platform. It understands business questions, investigates structured business data, identifies contributing factors, and gives explanations and recommendations grounded in evidence.

| BusinessPilot is | BusinessPilot is not |
|---|---|
| An analyst that plans and runs a bounded, multi-step investigation over structured data | A document RAG chatbot. Documents and glossary retrieval only support understanding |
| Driven by a per-tenant **semantic business model** (metrics, dimensions, relationships, definitions) that a human approves | Merely natural-language-to-SQL. The model never writes SQL; it produces validated query plans |
| Strict about numbers: every figure comes from a query result, a coded calculation or a tenant configuration value | A dashboard builder, an ERP, or an autonomous agent that acts in customer systems |

Its core asset is the per-tenant semantic model. It maps each business's own data and terminology to well-defined business entities, metrics and rules.

## Problem

SMEs keep operational data in spreadsheets, accounting or ERP databases and ad-hoc reports. Owners and managers depend on a few people to pull numbers, and the answers arrive late and are hard to cross-check. Traditional BI tools need modelling skills and dashboard upkeep that these companies usually do not have.

## Target customers (hypotheses to validate)

| Dimension | Initial hypothesis |
|---|---|
| Market | India |
| Segment | SMEs and mid-sized businesses, 20–200 employees |
| First industry | Wholesale distribution |
| Next industries | Manufacturing, multi-branch retail |
| Data sources | Excel, Google Sheets, PostgreSQL, MySQL, MongoDB. ERP and CRM connectors come later |
| Primary buyer and user | Owner or director, then finance and sales managers. People who need the "why" behind numbers but have no analyst |
| Fit signal | Recurring questions about revenue, receivables, margins and branch performance that currently take someone hours of spreadsheet work |

No market-size or adoption figures are claimed here. They must be gathered through customer discovery (Milestone 10).

## Users and permissions (examples)

| Persona | Typical access |
|---|---|
| Owner / director | All information the tenant has connected |
| Finance manager | Financial entities: invoices, payments, receivables, margins |
| Sales manager | Sales data for their assigned branches |
| Sales executive | Only the customers and records assigned to them |
| Tenant admin | Configuration, data sources, users. Not necessarily data access |

## Example questions

- Why did revenue decrease this month?
- Which customers have the highest outstanding payments?
- Which products have declining margins?
- Which branches are performing poorly?
- What are our top-selling products?
- What should management investigate this week?

## Core AI capabilities

These five capabilities define the product. Design: [docs/ai/analyst-orchestrator.md](docs/ai/analyst-orchestrator.md). Each one runs inside the existing security model: the LLM never decides permissions, and every data access is re-authorized by the api.

| # | Capability | What the user experiences | Guardrail |
|---|---|---|---|
| 1 | **Business intent understanding** | Questions in the business's own words ("dues", "collections", "slow movers") and follow-ups ("and Nashik?", "why?") are understood correctly, or a clarifying question is asked | Terms resolve only through the approved semantic model and glossary. No guessing |
| 2 | **Analytical planning** | The system chooses the right analysis: lookup, ranking, comparison, trend or diagnosis | Plans reference semantic IDs and are validated. No SQL from the model |
| 3 | **Multi-step investigation** | For "why" questions, the system breaks a change down, finds the largest contributors and drills into them | Bounded step catalog, budget and stop rules. Every step is re-authorized (ADR-0010, OPEN) |
| 4 | **Evidence-grounded diagnosis and explanation** | Contributing factors ranked by measured contribution, with facts, calculations, hypotheses and unknowns kept apart | Every number has provenance (ADR-0012, OPEN). External causes are always labelled as hypotheses |
| 5 | **Evidence-based recommendations** | Concrete next things to check or do, for example which customers to follow up for overdue payments | Each recommendation cites findings. Nothing is executed in customer systems (D-OPEN-23) |

## What a good answer looks like

Every answer separates:

1. **Verified facts:** values taken directly from query results.
2. **Derived calculations:** values computed in code from those results, such as percent change or share of total.
3. **Possible explanations:** hypotheses, labelled as hypotheses.
4. **Recommendations:** suggested next actions.
5. **Unknowns:** what the data cannot answer, or what is missing or stale.

Each answer also shows its data sources and how fresh they are, for example "Invoices synced 2 hours ago from Tally export.xlsx".

**Numerical provenance (strict).** Every number shown has exactly one recorded origin: a cell in an authorized query result, a calculation in code with its formula and inputs, or a tenant configuration value such as "overdue = more than 90 days". A number with no provenance is never shown. The answer is reduced to verified facts instead.

## MVP scope (the first vertical slice)

The MVP serves one industry template (wholesale distribution) with two source types, and puts a customer-facing outcome ahead of broad infrastructure.

In scope:

- Shared SaaS deployment (Model A), a small number of pilot tenants.
- Sources: **Excel upload** and **PostgreSQL** (read-only credentials), both in **managed synchronization** mode. Google Sheets follows next.
- Canonical entities: Customer, Product, Invoice (and lines), Payment, Branch.
- AI-assisted schema mapping with mandatory human approval.
- All five core AI capabilities at MVP depth:
  - intent understanding with typed follow-ups;
  - analytical planning for lookup, ranking, comparison, trend and diagnosis;
  - bounded investigation (decomposition plus at most one drill level, subject to ADR-0010);
  - diagnosis with evidence for every number;
  - recommendations from a small wholesale-distribution playbook, each citing evidence (D-OPEN-23).
- Contextual follow-up questions within a conversation (structured state, subject to ADR-0011).
- RBAC with branch-level ABAC (sales manager limited to assigned branches).
- Answer structure with sources and freshness, plus an audit log of questions and executed queries.
- Exact result caching.

Not in the MVP (later milestones):

- Live/federated query mode, MySQL, MongoDB, CDC-based sync.
- Semantic caching, document RAG beyond glossary and metric definitions.
- Open-ended or deep investigations beyond the bounded budget, forecasting, what-if simulation, statistical causal inference.
- Proactive insights (unprompted alerts or digests) and scheduled investigations.
- LLM-selected investigation steps, unless ADR-0010 option B is accepted after evaluation.
- Customer-hosted deployment (Model B).
- Write-back to source systems, alerts, scheduled reports, mobile apps.

## Product roadmap (phases)

The phases group the engineering milestones in [ROADMAP.md](ROADMAP.md). Milestone order and dependencies are unchanged.

| Phase | Milestones | Product outcome |
|---|---|---|
| 0. Foundation | M1 (done), M2 | Secure multi-tenant platform: isolation, authentication, authorization |
| 1. Business model and data | M3–M5 | A tenant's data is connected, mapped, synced and described by an approved semantic business model |
| 2. MVP AI Analyst | M6 | Capabilities 1–5 at MVP depth on the wholesale template: answers with evidence, bounded investigation, follow-ups, playbook recommendations |
| 3. Deeper understanding and efficiency | M7–M8 | Better term and synonym understanding through retrieval of approved definitions. Caching lowers cost per answer |
| 4. Pilot | M9–M10 | Self-serve onboarding. Evaluation on pilot-shaped data. 2–5 pilot distributors |
| Later | — | Proactive insights, deeper or adaptive investigation (if evaluation supports it), more templates and connectors, customer-hosted edition |

## Non-goals

- Replacing ERP, accounting or CRM systems.
- Free-form autonomous agents, or any feature that takes actions in customer systems.
- A general-purpose document chatbot.
- Answering questions with numbers that were not derived from customer data.
- Collecting more customer data than an approved question set needs.

## Commercial considerations (open)

Pricing model, packaging (per tenant, per seat or usage-based), LLM cost per question and gross margin targets are not decided yet (D-OPEN-11 in [DECISIONS.md](DECISIONS.md)). The architecture tracks cost per answer from the start ([AI_ENGINEERING.md](AI_ENGINEERING.md#observability)) so pricing can be based on measurements.

## Regulatory note

BusinessPilot will process personal and financial data of Indian businesses. India's Digital Personal Data Protection Act, 2023 and its rules apply. BusinessPilot makes **no compliance or certification claims**. Legal review is a precondition for the customer pilot (Milestone 10).
