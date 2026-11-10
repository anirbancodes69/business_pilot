# BusinessPilot

BusinessPilot is a configuration-driven, multi-tenant, AI-powered business intelligence platform. Business owners, finance managers and operations managers ask questions about their own business data in plain language, for example "Why did revenue decrease this month?". BusinessPilot answers by running authorized, structured queries and explaining the results.

It is **not** a chatbot over uploaded documents. Every number in an answer must come from a structured query result or a deterministic calculation on one.

> **Status: Architecture and documentation initialization.** Application development has not started, and no application code exists. See [CURRENT.md](CURRENT.md) for what has actually been built.

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
  web/            Next.js frontend (not started)
  api/            NestJS modular monolith: HTTP API process + worker process (not started)
  ai-engine/      Python + FastAPI AI orchestration service (not started)
packages/
  shared-types/   TypeScript types shared by web and api (not started)
  config-schema/  Validators generated from /schemas (not started)
  api-contracts/  OpenAPI specs and generated clients (not started)
contracts/        Interface contracts between components (connector, tenant, semantic model, AI)
schemas/          JSON Schemas for configuration documents (the source of truth for config)
infrastructure/   Docker, PostgreSQL, Redis and monitoring setup (not started)
docs/             Architecture, data, AI and security designs, plus ADRs
.github/workflows/ CI definition (documentation and schema checks only; not yet run)
```

## Licensing and provenance

This is an independent, greenfield product. It contains no proprietary third-party code, customer data or credentials. A license has not been chosen yet (see [DECISIONS.md](DECISIONS.md), D-OPEN-10).
