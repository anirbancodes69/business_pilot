# PRODUCT.md — Product definition

## Vision

BusinessPilot lets the people who run a business ask questions of their own data in plain language and get trustworthy answers: which numbers changed, by how much, where, and what to look at next. It does this without a data team, a BI tool rollout or a re-platforming project.

BusinessPilot is a **configurable business intelligence platform**. It is not a document chatbot. Its core asset is a per-tenant semantic model that maps each business's own data and terminology to well-defined business entities and metrics.

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

## What a good answer looks like

Every answer separates:

1. **Verified facts:** values taken directly from query results.
2. **Derived calculations:** values computed in code from those results, such as percent change or share of total.
3. **Possible explanations:** hypotheses, labelled as hypotheses.
4. **Recommendations:** suggested next actions.
5. **Unknowns:** what the data cannot answer, or what is missing or stale.

Each answer also shows its data sources and how fresh they are, for example "Invoices synced 2 hours ago from Tally export.xlsx".

## MVP scope (the first vertical slice)

The MVP serves one industry template (wholesale distribution) with two source types, and puts a customer-facing outcome ahead of broad infrastructure.

In scope:

- Shared SaaS deployment (Model A), a small number of pilot tenants.
- Sources: **Excel upload** and **PostgreSQL** (read-only credentials), both in **managed synchronization** mode. Google Sheets follows next.
- Canonical entities: Customer, Product, Invoice (and lines), Payment, Branch.
- AI-assisted schema mapping with mandatory human approval.
- Natural-language questions answered through query plans: metric lookups, rankings, period comparisons, and bounded "why" breakdowns.
- RBAC with branch-level ABAC (sales manager limited to assigned branches).
- Answer structure with sources and freshness, plus an audit log of questions and executed queries.
- Exact result caching.

Not in the MVP (later milestones):

- Live/federated query mode, MySQL, MongoDB, CDC-based sync.
- Semantic caching, document RAG beyond glossary and metric definitions.
- Customer-hosted deployment (Model B).
- Write-back to source systems, alerts, scheduled reports, mobile apps.

## Non-goals

- Replacing ERP, accounting or CRM systems.
- Free-form autonomous agents that take actions in customer systems.
- Answering questions with numbers that were not derived from customer data.
- Collecting more customer data than an approved question set needs.

## Commercial considerations (open)

Pricing model, packaging (per tenant, per seat or usage-based), LLM cost per question and gross margin targets are not decided yet (D-OPEN-11 in [DECISIONS.md](DECISIONS.md)). The architecture tracks cost per answer from the start ([AI_ENGINEERING.md](AI_ENGINEERING.md#observability)) so pricing can be based on measurements.

## Regulatory note

BusinessPilot will process personal and financial data of Indian businesses. India's Digital Personal Data Protection Act, 2023 and its rules apply. BusinessPilot makes **no compliance or certification claims**. Legal review is a precondition for the customer pilot (Milestone 10).
