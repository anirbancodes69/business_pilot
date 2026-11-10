# CLAUDE.md — Rules for AI coding agents

These rules apply to every AI coding session in this repository (Claude Code, ChatGPT, others). Keep this file short. Detailed designs live in the referenced documents.

## Product in one paragraph

BusinessPilot is a multi-tenant SaaS that lets authorized business users ask natural-language questions about their own business data. A deterministic AI pipeline turns each question into a validated **query plan**. The trusted API checks that plan against the user's permissions and runs it as structured queries. The AI engine then explains the results, separating verified facts, derived calculations, possible explanations, recommendations and unknowns. The first customers are Indian SMEs, starting with wholesale distributors.

## Before you write code

1. Read [CURRENT.md](CURRENT.md). It is the only source of truth for what exists. If it says something is not implemented, it is not.
2. Read the documents relevant to your task:
   - Any task: [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](DECISIONS.md)
   - Auth, tenants, data access, caching: [SECURITY.md](SECURITY.md) (mandatory)
   - Connectors, sync, storage: [DATA_CONNECTIVITY.md](DATA_CONNECTIVITY.md)
   - AI pipeline, prompts, caching, evaluation: [AI_ENGINEERING.md](AI_ENGINEERING.md)
   - Setup, conventions, commands: [DEVELOPMENT.md](DEVELOPMENT.md)
   - Choosing the next work: [ROADMAP.md](ROADMAP.md)
3. Check the relevant interface contract in [contracts/](contracts/) and configuration schema in [schemas/](schemas/) before you change any boundary between components.

## Non-negotiable rules

1. **Tenant isolation.** Every tenant-owned row, Redis key, vector index, file, cache entry, job payload and audit event carries a `tenant_id`. PostgreSQL tenant tables use Row-Level Security (RLS) with `FORCE ROW LEVEL SECURITY`. Tenant context is set with `SET LOCAL` inside a transaction, never at session level. The only RLS exceptions are the two defined in [SECURITY.md §4](SECURITY.md#4-tenant-isolation-in-postgresql). Do not add others without an ADR.
2. **The LLM never decides permissions.** Authorization is computed by the API before any AI call. The API re-checks it when it executes a plan. Never trust tenant IDs, user IDs, filters or scopes that come from model output.
3. **The AI engine never connects to tenant data stores.** It reaches data only through the API's internal tool endpoints ([contracts/ai/](contracts/ai/)).
4. **Numbers come from queries.** The model must not compute or invent financial figures. Derived calculations (percent change, share of total) are done in code.
5. **No raw LLM-written SQL in production paths.** The model produces a `QueryPlan`. The API compiles it to parameterized SQL.
6. **Cache identity** always includes tenant, authorization scope hash, normalized plan hash, semantic model version, data version and cache policy version. Embedding similarity alone never returns a financial result.
7. **Secrets.** Never commit credentials. Never log connector credentials, tokens, prompts that contain tenant data, or query result rows. `.env.example` contains placeholders only.
8. **Human approval.** AI-suggested schema mappings and semantic model changes stay inactive until a human approves them.
9. **Minimize data.** Sync and embed only what the customer approved. Personal and financial records are not embedded by default.

## Working rules

- **Never invent implementation status.** Do not claim something works unless you ran it. Documented is not the same as implemented.
- **Ask before major architectural changes:** a new service, datastore, queue, framework or cloud dependency; a change to tenant isolation; a change to a contract in `contracts/`. Propose an ADR first.
- **Avoid unnecessary dependencies.** Prefer the standard library and the stack in [ADR-0008](docs/adr/ADR-0008-technology-selection.md). Justify each new package in the PR description. No Kafka or Kubernetes without an accepted ADR.
- **Keep a modular monolith.** New backend capabilities become NestJS modules in `apps/api`, not new services.
- **Tests are required.** Run the test suites listed in [DEVELOPMENT.md](DEVELOPMENT.md) before finishing. None exist until Milestone 1 creates them. Never report tests as passing if they were not run. Any change touching data access, caching, jobs or retrieval must add or update the tenant isolation tests ([docs/security/tenant-isolation-tests.md](docs/security/tenant-isolation-tests.md)).
- **Conventions:** TypeScript strict mode, ESLint, Zod at runtime boundaries. Python 3.12+, ruff, mypy strict, Pydantic v2, pytest. Conventional Commits. Details in [DEVELOPMENT.md](DEVELOPMENT.md).

## After meaningful work

1. Update [CURRENT.md](CURRENT.md): move items between Pending, In progress and Completed, record known issues, set the next three tasks, and update the date.
2. If an architectural decision changed or was made, add or update an ADR in [docs/adr/](docs/adr/) and its row in [DECISIONS.md](DECISIONS.md). Do not mark a decision Accepted unless the product owner confirmed it.
3. Keep docs, contracts, schemas and code consistent. If you find a contradiction, fix it or record it under Known issues in CURRENT.md.


## AI Development Workflow

Follow [AI_WORKFLOW.md](AI_WORKFLOW.md) for:
- Context and token optimization
- Model selection
- Prompt caching practices
- Session management
- Efficient repository exploration
- AI-assisted development standards

Read this document when starting a substantial development task
or when changing the AI development workflow.
