# Deployment models

Decision: [ADR-0001](../adr/ADR-0001-deployment-strategy.md). Model A is the launch target. Model B is designed for but not built.

## Terminology (do not conflate)

| Term | What runs where | Who operates the stack | Typical reason |
|---|---|---|---|
| **Private connector** | BusinessPilot runs in its SaaS. A small component or tunnel lets it reach a data source inside the customer network | BusinessPilot (the customer runs only the connector component) | The database is not reachable from the internet |
| **Private Cloud / BYOC** | The whole BusinessPilot stack runs in the customer's cloud account (AWS, Azure, GCP) | The customer, or BusinessPilot with delegated access | Data must stay in the customer's cloud account |
| **On-premises** | The whole stack runs on customer-operated hardware or a private data centre | The customer | Regulatory or policy reasons, no public cloud |

A private connector does **not** make a deployment private. Data still flows into the SaaS (managed sync) or through it (live mode).

## Model A — Shared SaaS

- One installation, many tenants, logical isolation ([ADR-0003](../adr/ADR-0003-tenant-isolation.md)).
- Proposed hosting: containers on a managed container platform in an India region, with managed PostgreSQL, managed Redis (or self-run Redis Stack if the managed service lacks search and vector), and object storage. The provider is D-OPEN-04.
- Environments: `local` (Compose), `staging`, `production`. No customer data in local or staging.
- Backups: managed PostgreSQL point-in-time recovery. RPO and RTO targets are D-OPEN-17. Redis data falls into three classes:
  - The cache is disposable.
  - The vector index is rebuildable through a full re-index job from PostgreSQL and approved content.
  - Queued jobs are **not** disposable. An outbox event marked published but lost from Redis would be missed. Redis therefore runs with AOF persistence (P-14), and a periodic reconciliation compares indexed `data_version`s with PostgreSQL and re-queues any gaps.

## Model B — Customer-hosted (future)

Components: web, api, worker, ai-engine, PostgreSQL, Redis Stack, object storage (MinIO or the customer's), and monitoring (OpenTelemetry collector + Grafana). A first packaging target is a versioned Docker Compose bundle with an installer script and an upgrade runbook (D-OPEN-09).

Considerations to design before the first Model B deal:

- LLM endpoint: the customer's approved provider or a regional endpoint. Document that prompts and aggregated results leave the network if the provider is external.
- Identity: the customer's OIDC/SAML IdP.
- Keys: the customer's KMS or Vault through the `KeyManagement` port.
- Updates: signed images, a release channel, database migration compatibility.
- Support: diagnostics bundle without tenant data. No remote access by default.
- Licensing of bundled components (Redis distribution, see [ADR-0008](../adr/ADR-0008-technology-selection.md)).

## Portability rules for code today

1. No cloud SDK imports outside adapter modules.
2. All configuration comes from environment variables or validated configuration documents.
3. No dependence on managed-service-only features, such as provider-specific PostgreSQL extensions, without an adapter or ADR.
4. All services must start and pass health checks in `infrastructure/docker/compose.yaml`.
