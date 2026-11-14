# BusinessPilot

BusinessPilot is an **AI Business Analyst**: a configuration-driven, multi-tenant business intelligence platform. It understands business questions, investigates structured business data, identifies contributing factors, and gives explanations and recommendations grounded in evidence. Business owners, finance managers and operations managers ask questions about their own business data in plain language, for example "Why did revenue decrease this month?". BusinessPilot answers by running authorized, structured queries and explaining the results.

It is **not** a chatbot over uploaded documents, and not merely natural-language-to-SQL. Every number in an answer must come from a structured query result or a deterministic calculation on one.

> **Status: foundation built, product not yet usable.** Milestones 1 to 4 are merged to `main`. Milestone 4 exists at API level only. There is no user interface, no data sync and no AI answer pipeline yet, so nobody can ask a question today. [CURRENT.md](CURRENT.md) is the source of truth for what exists.

## What exists today

| Milestone | Scope | State |
|---|---|---|
| 1 | Repository, three app skeletons, Docker Compose stack, CI, tracing | Merged |
| 2 | Tenants, login token verification, roles and permissions, Row-Level Security, audit log, credential encryption | Merged |
| 3 | Semantic model versions, the wholesale distribution template, access policies, the authorized view | Merged |
| 4 | Connector framework, PostgreSQL and Excel connectors, human approval of objects, mapping workflow | Merged, API only |
| 5 | Sync engine | Not started |
| 6 | AI pipeline: query plans, SQL compiler, grounded answers, investigation, chat UI | Not started |
| 7 to 10 | Retrieval, caching, onboarding, pilot | Not started |

What that means in practice:

- **Works, through the API:** a tenant admin can publish a semantic model, activate an access policy, connect a PostgreSQL database or upload an Excel file, see the discovered schema, and review, approve and activate a mapping.
- **Enforced and tested:** one tenant cannot read or change another tenant's data. This is checked by an isolation test suite that runs against a real PostgreSQL.
- **Not built:** loading customer data into the analytical tables, asking questions, any AI call (the LLM provider is a stand-in that calls no model), and every screen.
- **Local stand-ins:** sign-in uses a Keycloak container, and uploaded files are kept on a Docker volume. Both work on one machine only.
- **Not chosen yet:** the LLM provider, and the identity provider and object storage product for hosted environments.

Milestone definitions and acceptance criteria are in [ROADMAP.md](ROADMAP.md).

## Quick start

Needs Docker with Compose v2, Node.js 24, pnpm and [uv](https://docs.astral.sh/uv/). Full instructions are in [DEVELOPMENT.md](DEVELOPMENT.md).

```bash
./scripts/setup-local-env.sh     # creates .env with random local secrets; never overwrites an existing one
pnpm install
uv sync --directory apps/ai-engine
pnpm stack:up                    # builds and starts all services
pnpm check                       # lint, type-check and unit tests
pnpm test:isolation              # tenant isolation suite; needs the postgres service running
```

Sign-in uses the Keycloak in the stack. Create users in its admin console at http://localhost:8080 (user `admin`, password `KEYCLOAK_ADMIN_PASSWORD` from `.env`). A new user has no tenant until an operator creates one with `pnpm tenant:provision`. See [DEVELOPMENT.md](DEVELOPMENT.md#signing-in-locally).

## Who it is for

The first market is Indian SMEs and mid-sized businesses (20–200 employees). The first industry hypothesis is wholesale distribution. Their data lives in Excel, Google Sheets, PostgreSQL, MySQL and MongoDB. See [PRODUCT.md](PRODUCT.md).

## Documentation map

| Document | Purpose |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Entry point and rules for AI coding agents. **Read first.** |
| [AI_WORKFLOW.md](AI_WORKFLOW.md) | How to use AI coding assistants efficiently: model choice, context, sessions, cost |
| [CURRENT.md](CURRENT.md) | Living status: what is implemented, in progress and next |
| [PRODUCT.md](PRODUCT.md) | Vision, customers, MVP scope, non-goals |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System overview, components, request lifecycle, deployment models |
| [DECISIONS.md](DECISIONS.md) | Register of every architectural decision and its status |
| [SECURITY.md](SECURITY.md) | Security model, tenant isolation, authorization, data handling |
| [DATA_CONNECTIVITY.md](DATA_CONNECTIVITY.md) | Connectors, access modes, storage, synchronization |
| [AI_ENGINEERING.md](AI_ENGINEERING.md) | AI orchestration, semantic layer, caching, evaluation |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Local setup, conventions, testing, workflow |
| [ROADMAP.md](ROADMAP.md) | Milestones, epics, dependencies, acceptance criteria |
| [docs/](docs/) | Detailed designs and Architecture Decision Records ([docs/adr/](docs/adr/)) |

## Repository layout

```
apps/
  web/            Next.js frontend (app shell only)
  api/            NestJS modular monolith: HTTP API process + worker process (M1 to M4 at API level; worker has no jobs yet)
  ai-engine/      Python + FastAPI AI orchestration service (health endpoint and a dummy LLM port only)
packages/
  shared-types/   TypeScript types shared by web and api (not started)
  config-schema/  Validators generated from /schemas (not started)
  api-contracts/  OpenAPI specs and generated clients (not started)
contracts/        Interface contracts between components (connector, tenant, semantic model, AI)
schemas/          JSON Schemas for configuration documents (the source of truth for config)
infrastructure/   Docker Compose stack, PostgreSQL role setup, Redis and monitoring notes
docs/             Architecture, data, AI and security designs, plus ADRs
.github/workflows/ CI: docs and schema checks, lint, type-check, tests, tenant isolation suite, secret scan, dependency audit, Compose smoke test
```

## Licensing and provenance

This is an independent, greenfield product. It contains no proprietary third-party code, customer data or credentials. A license has not been chosen yet (see [DECISIONS.md](DECISIONS.md), D-OPEN-10).
