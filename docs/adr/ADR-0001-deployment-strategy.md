# ADR-0001: Deployment strategy

- **Status:** Accepted (D-01). Packaging for customer-hosted deployments is OPEN (D-OPEN-09). The cloud provider is OPEN (D-OPEN-04).
- **Date:** 2026-11-10

| Item | Status |
|---|---|
| D-01 Shared SaaS first; customer-hosted later; portable application logic | Accepted |
| D-OPEN-04 Cloud provider and region | OPEN |
| D-OPEN-09 Customer-hosted packaging and update channel | OPEN |

## Context

The first customers are Indian SMEs. They need fast onboarding and low cost, and most cannot run infrastructure themselves. Larger or regulated customers will later ask for deployment inside their own AWS or Azure account, private cloud or data centre. Building both from day one would delay the product. Ignoring Model B would lead to SaaS-only assumptions (managed services hard-wired into code) that are expensive to remove later.

## Decision

1. Launch as **Model A, shared SaaS**: one multi-tenant installation operated by BusinessPilot.
2. Design for **Model B, customer-hosted**, without building it yet:
   - Application code depends on infrastructure **ports** (`ObjectStorage`, `KeyManagement`, `SecretStore`, `LlmProvider`, `EmbeddingProvider`, `VectorStore`, `Queue`, `IdentityProvider`). See [ARCHITECTURE.md §2](../../ARCHITECTURE.md#infrastructure-ports-deployment-independence).
   - All components ship as containers. Docker Compose is the reference topology for both local development and the first Model B bundle.
   - Multi-tenancy stays enabled in Model B (typically one tenant), so there is a single code path.
   - Configuration documents ([schemas/](../../schemas/)) are identical across models. This makes export and import between them possible.
3. Keep the three deployment terms distinct: **private connector** (data access path), **private cloud / BYOC** (stack in the customer's cloud account) and **on-premises** (stack in customer-operated facilities). See [docs/architecture/deployment-models.md](../architecture/deployment-models.md).

## Alternatives considered

- **Single-tenant SaaS (one stack per customer) from day one.** Strong isolation, but cost and operational load per tenant are too high for SMEs.
- **Customer-hosted only.** Slow sales cycles and support burden. SME targets cannot operate it.
- **SaaS with hard-wired cloud services.** Faster at first, but blocks Model B.

## Advantages

- Lowest cost per tenant and fastest iteration for the MVP.
- One codebase, with Model B as a packaging and adapter exercise rather than a rewrite.

## Disadvantages

- Ports add a small abstraction cost now.
- Customer-hosted support (upgrades, diagnostics without access to the customer's environment) remains undesigned.

## Security implications

- Model A relies on logical isolation, so the controls in [ADR-0003](ADR-0003-tenant-isolation.md) are mandatory, not optional.
- Model B moves infrastructure security to the customer. LLM provider calls may leave the customer's network unless a customer-approved endpoint is configured. This must be explicit in Model B documentation.

## Consequences

- No module may import a cloud SDK directly. Cloud SDKs are allowed only inside adapters.
- CI should eventually run the full stack in Compose to prove portability.

## Revisit conditions

- A signed customer requires Model B. Then decide D-OPEN-09.
- The SaaS tenant count or load makes Compose-style deployment insufficient. Then write an ADR on orchestration (which might include Kubernetes).
