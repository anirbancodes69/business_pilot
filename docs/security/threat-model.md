# Threat model (initial)

STRIDE-style summary at architecture level. Refresh at Milestone 6 and before the pilot (Milestone 10).

## Assets

Tenant business data (synced records, results), connector credentials, LLM provider keys, the semantic model and mappings (the tenant's intellectual property), conversations, audit logs, and the signing keys for RequestContexts.

## Trust boundaries

1. Internet ↔ web/api.
2. api ↔ ai-engine (internal network, service authentication).
3. ai-engine ↔ LLM provider (third party, outside BusinessPilot's control).
4. worker ↔ customer data sources (the customer's network).
5. api/worker ↔ PostgreSQL/Redis/object storage.

## Threats and controls

| Threat | Category | Control |
|---|---|---|
| A user accesses another tenant's data | Information disclosure | Layered isolation ([ADR-0003](../adr/ADR-0003-tenant-isolation.md)), tests TI-01 to TI-14 |
| A user exceeds their role or branch scope | Elevation of privilege | AuthorizationContext, plan re-authorization, ABAC injection in the compiler |
| Prompt injection through a question or synced data | Tampering / EoP | Model has no authority, signed context, plan validation, data delimiting |
| Generated SQL injection or exfiltration | Tampering | No raw SQL. Allow-listed compiler, parameters, read-only transactions |
| Forged internal calls to api tools | Spoofing | Service authentication + signed short-lived RequestContext; ai-engine not public |
| Credential theft from the database | Information disclosure | Envelope encryption, a KMS-held key-encryption key, credentials never returned |
| SSRF through connector host configuration | Tampering | Block private, link-local and metadata IP ranges for SaaS sources. Egress allow-list |
| A malicious spreadsheet (formula injection, zip bomb, oversized file) | DoS / tampering | Size and cell limits, parse values only (no formula evaluation), a sandboxed parser, CSV-injection-safe exports |
| An LLM provider retains or trains on data | Information disclosure | Minimized payloads, PII masking, contractual terms (D-OPEN-14) |
| Cost exhaustion through heavy questions | DoS | Quotas, tool-call caps, timeouts, per-tenant rate limits |
| Audit tampering | Repudiation | Append-only table, no update or delete grants for the app role |
| Cache poisoning across scopes | Information disclosure | Scoped keys, writes only after validated execution |

## Open security questions

The RequestContext signing scheme (D-OPEN-15), the KMS choice (with D-OPEN-04), the private connector trust model (D-OPEN-08), and the support-access model for Model B (with D-OPEN-09).
