# ADR-0015: Dummy LLM provider and object storage adapters (provisional)

- **Status:** Accepted for the interim approach (product owner, 2026-11-14). The real choices stay OPEN.
- **Date:** 2026-11-14
- **Decision items:** D-15 (new, Accepted). D-OPEN-01 (LLM provider) and D-OPEN-24 (object storage product, new) remain OPEN.

## Context

Milestone 4 needs an LLM for mapping suggestions (E4.0, E4.4) and object storage for Excel uploads (E4.2). Neither product is chosen. The local MinIO image is no longer published (see CURRENT.md known issues), and the LLM provider needs data-processing terms the product owner has not reviewed. Waiting would block the rest of Milestone 4.

## Decision

1. Both capabilities sit behind ports, and the only adapter for each is a **dummy** one:
   - `LlmProvider` (`apps/ai-engine/src/ai_engine/llm/`). `DummyLlmProvider` calls no model and returns one fixed text. It reports `is_real = False`, so callers fall back to deterministic logic (name-similarity mapping suggestions, as ROADMAP E4.4 already allows).
   - `ObjectStorage` (`apps/api/src/platform/object-storage/`). `DummyObjectStorage` keeps bytes in process memory. It is not durable and is not shared between the api and the worker. The port forces every key under `tenants/{tenant_id}/` and rejects keys that could escape it.
2. A setting picks the adapter (`LLM_PROVIDER`, `OBJECT_STORAGE_DRIVER`). Only `dummy` is accepted, and any other value fails closed.
3. This does **not** confirm a real provider or product. D-OPEN-01 and D-OPEN-24 stay OPEN. The earlier recommendation (a hosted model behind the port, evaluated in Milestone 6) is unchanged and unaccepted.
4. The dummy adapters must not reach a real customer. No pilot tenant may be onboarded while either adapter is a dummy.

## Alternatives considered

- **Pick a provider and storage product now.** Needs product-owner decisions on data terms, region and licensing that are not ready.
- **Block Milestone 4 until decided.** Stalls unrelated work.
- **Fake it inside product code.** Spreads stand-in logic into callers and makes the later swap risky. A port keeps the swap to one adapter.

## Advantages

- Milestone 4 continues. The later swap touches one adapter per capability.
- No tenant data goes to an external service while the dummy is in place.

## Disadvantages

- Uploaded files vanish on restart, and the worker cannot read what the api stored. An upload flow built now cannot sync in the background until real storage exists.
- No AI-assisted mapping is possible. Suggestions come from heuristics only.

## Security implications

- The dummy LLM sends nothing anywhere and does not log prompts.
- The tenant prefix and key validation live in the port, so the real adapter inherits them. Tenant isolation tests for storage must run against the real adapter when it exists.

## Consequences

- E4.2 may parse and discover an uploaded file within one request, but cannot persist it for sync (Milestone 5).
- The evaluation spike in E6.1 and the storage choice must be scheduled before any pilot.

## Revisit conditions

- The product owner chooses the LLM provider (D-OPEN-01) or the storage product (D-OPEN-24).
- Before Milestone 5 (the worker needs shared storage) and before any pilot tenant.
