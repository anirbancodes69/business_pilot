# ADR-0004: Connector architecture

- **Status:** Proposed (P-04). The human-approval requirement is Accepted (D-10). The private connector agent is OPEN (D-OPEN-08). The live-mode scope is OPEN (D-OPEN-07).
- **Date:** 2026-11-10

| Item | Status |
|---|---|
| P-04 One connector interface plus a capability descriptor, running in the api/worker process | Proposed |
| D-10 Human approval of AI-suggested mappings | Accepted |
| D-OPEN-07 Live/federated mode scope | OPEN |
| D-OPEN-08 Private connector agent | OPEN |

## Context

Sources differ in query language, change detection, delete visibility, schema rigidity, authentication and rate limits. Excel, Google Sheets, PostgreSQL, MySQL and MongoDB come first. ERP and CRM connectors follow. The sync engine and the plan compiler must not hard-code source-specific behaviour, and some capabilities, such as CDC, exist only on some sources.

## Decision

1. One connector interface ([contracts/connector/](../../contracts/connector/)) with the operations `describeCapabilities`, `testConnection`, `discoverSchema`, `readSnapshot`, `readChanges`, `listKeys` and the optional `executeFederated`.
2. Each connector publishes a **capability descriptor** ([connector-capabilities.schema.json](../../contracts/connector/connector-capabilities.schema.json)). The sync engine chooses its strategy from the descriptor, never from the connector type.
3. Connectors are **stateless**. Configuration, decrypted credentials and checkpoints are injected for each call.
4. Connectors run **in-process**: in the api only for the quick `testConnection`, and in the worker for everything else (discovery, file parsing, sync), as jobs. That keeps slow or heavy work out of the HTTP process. They are NestJS providers registered in a connector registry.
5. AI-assisted mapping is a suggestion step only. Mappings activate after human approval (D-10).
6. MVP connectors: Excel upload and PostgreSQL, both managed sync.

## Alternatives considered

- **Use an existing ELT framework (for example Airbyte or Singer taps).** Many connectors already exist, but it means heavy infrastructure, a different runtime, and less control over tenant isolation and credentials. It could be reconsidered for the long tail of SaaS connectors.
- **One microservice per connector.** Operational overhead without benefit at this scale.
- **Source-specific code paths in the sync engine.** Fast at first, but it does not scale to more sources.

## Advantages

- New sources plug in without core changes.
- Capability-driven strategy keeps the source-specific limits explicit.

## Disadvantages

- In-process connectors share the worker's resources. A misbehaving driver can affect other jobs. This is mitigated by timeouts, concurrency limits and separate queues per connector type.
- Reaching firewalled customer databases is not solved yet (D-OPEN-08).

## Security implications

- Credentials are decrypted only inside connector calls and never logged.
- `testConnection` warns about excess privileges (for example write access).
- `executeFederated` accepts only compiler-generated read-only queries and has no raw query entry point.
- Network egress from workers to customer sources must be controlled (allow-list per tenant source host), which also guards against server-side request forgery (SSRF) to internal addresses.

## Consequences

- The capability schema is a versioned contract. Changes need compatibility notes.
- A shared connector test kit (contract tests) must exist before the second connector.

## Revisit conditions

- Demand for many SaaS sources (ERP, CRM). Then reconsider an ELT framework for those.
- Customer sources behind firewalls appear in the pipeline. Then design D-OPEN-08.
- Worker instability caused by connectors. Then isolate connector workers into their own process pool.
