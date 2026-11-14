# ADR-0019: OpenAI as the provisional LLM provider

- **Status:** Accepted (provisional), chosen by the product owner on 2026-11-15
- **Date:** 2026-11-15
- **Decision items:** D-24, partly settles D-OPEN-01 (stays OPEN until confirmed)

## Context

Milestone 6 needs a real model for the planner and the explainer. The product owner has an OpenAI account and chose it. The `LlmProvider` port ([ADR-0015](ADR-0015-dummy-llm-and-object-storage-adapters.md)) keeps product code independent of the vendor.

## Decision

- An `OpenAiProvider` adapter in ai-engine calls the Chat Completions API over HTTPS with `httpx` (already a dependency in the dev group, now a runtime one; no vendor SDK).
- `LLM_PROVIDER=openai` selects it. `LLM_API_KEY`, `LLM_MODEL_PLANNER` and `LLM_MODEL_EXPLAINER` are required; there is no default model, so a missing value fails at start instead of picking a model silently.
- Only ai-engine holds the key. It is never logged, never sent to the api and never in an error message.
- Planner and explainer use separate model ids so cost and quality can be tuned apart.

## Alternatives considered

- Other vendors: not chosen by the product owner. The port keeps them possible.

## Advantages

- Works now, with an account the owner already has. Structured JSON output is supported.

## Disadvantages and risks

- **Tenant data leaves the system.** The explainer receives bounded result rows, which are tenant business data. Until the data-processing terms, retention and training settings of the OpenAI account are reviewed (D-OPEN-14, E10.3), use **synthetic data only**. No pilot tenant.
- Model behaviour changes between versions. The golden set (E6.6) must be run against the pinned model id.
- Cost per answer is unmeasured until metering (E6.8).

## Security implications

- Prompts contain the authorized semantic view, the question and, for the explainer, bounded results. They never contain credentials, tenant ids, user ids, physical names or row filter values. They are not logged (CLAUDE.md rule 7).
- The model never decides permissions (rule 2). Its output is validated as a `QueryPlan` and re-authorized by the api.

## Revisit conditions

- The evaluation shows poor planning accuracy or cost per answer is too high.
- The data-processing review does not allow the use for customer data.
