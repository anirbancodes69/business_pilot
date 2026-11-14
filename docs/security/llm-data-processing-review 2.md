# LLM data processing review (D-OPEN-14, D-24)

**Date:** 2026-11-15. **Scope:** what BusinessPilot sends to the AI model provider (OpenAI, [ADR-0019](../adr/ADR-0019-openai-llm-provider.md)), what the provider does with it, the gaps, and what must happen before a real customer's data is used. **Written by an AI coding assistant from the code and from public documents. It is not legal advice.** The provider's terms below come from search results, mostly third-party summaries of OpenAI's pages; the product owner must confirm them against OpenAI's current documents and the account's own settings. Items for counsel are marked *(counsel)*.

## Conclusion

| Use | Verdict |
|---|---|
| Development and evaluation with synthetic data (today) | **Acceptable.** |
| A pilot tenant with real customer data | **Not approved yet.** Eight blockers, listed under "Before the first pilot" below. Two are done in code (consent switch, exclusion of tagged fields); six need the product owner, OpenAI or counsel. |

## 1. What is sent, call by call

Verified in the code (`apps/ai-engine/src/ai_engine/planning/prompts.py`, `planning/followup.py`, `answer/explainer.py`, `answer/attention.py`) and by tests that check what the prompts contain.

| Call | Content sent to the provider | Sensitive content |
|---|---|---|
| Planner (every question) | Fixed instructions; the user's **question text**; the user's authorized **catalog** (measure and dimension ids, labels, synonyms, units, business-rule labels, glossary terms); today's date and the fiscal-year start | The question can contain anything the user types, including customer or person names. The catalog is configuration, not business records. |
| Follow-up classifier (a follow-up in a conversation) | Catalog; the previous analysis's **focus** (measure and dimension ids, filter **values** such as a branch name, time range, sort, limit); the question | Filter values the user chose. |
| Explainer (most answers) | The question; **result rows**, each number as an evidence id plus its rendered text (for example "₹1.96 lakh"); the **names** of the members in the rows (customers, products, branches); labels of calculations; short fixed notes. Up to 50 rows per result set, two sets for a comparison, about 10 rows for change tables and findings | **Customer, product and branch names with their amounts.** This is business data, and where a customer is a sole proprietor it can be personal data. |
| Weekly briefing | The planner call only. The briefing text is written by code | As for the planner. |
| Investigation ("why") | Planner call, then the explainer with the findings rows (a handful of members and shares) | As for the explainer. |

**Never sent:** credentials, tokens, tenant ids, user ids, emails, request ids, physical table or column names, SQL, row-filter values, the semantic model's expressions, the full conversation history, other tenants' anything, raw rows beyond the shown ones, and anything the user is not authorized to see (the catalog and the results are already filtered by the user's permissions).

**Not logged by BusinessPilot:** prompts, replies and result rows are not written to logs, traces or audit events. Only fixed texts and counts are (checked: `ai-engine` logs a planning failure as fixed text; `core.ai_execution` stores counts and model names only). The user's own **conversation history** now stores the question and the answer as shown (ADR-0021: private to the user, 90 days by default, deletable).

## 2. What the provider does with it (to be confirmed)

Sources: [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data), [ZDR with Private Safety Processing](https://developers.openai.com/api/docs/guides/private-safety-processing), [Data residency for the OpenAI API](https://help.openai.com/en/articles/10503543-data-residency-for-the-openai-api), [Sub-processor list](https://openai.com/policies/sub-processor-list/), [Business data privacy](https://openai.com/business-data/), [OpenAI on India processing (Business Standard, 12 Nov 2026)](https://www.business-standard.com/technology/artificial-intelligence/openai-to-process-ai-requests-in-india-to-meet-data-localisation-needs-126111200782_1.html), and third-party summaries ([developersdigest](https://www.developersdigest.tech/models/data-retention/openai), [meetily](https://meetily.ai/llm-privacy/openai)).

- **Training:** API data is not used to train models by default (reported as the policy since 1 March 2023) unless the customer opts in. *Confirm in the account.*
- **Retention:** by default, inputs and outputs may be kept up to **30 days** in abuse-monitoring logs, longer if the law requires. **Zero Data Retention (ZDR)** and **Modified Abuse Monitoring** remove this, but are **not self-serve: OpenAI must approve the request**, chosen per organization or project. Some features are not eligible; safety-flagged content can still be kept. A newer option, ZDR with Private Safety Processing, is described in the docs.
- **Role and contract:** OpenAI describes itself as a processor for business and API customers under its Data Processing Addendum (a January 2026 version is reported, with standard contractual clauses for transfers). *Confirm that the account is under the DPA and obtain the signed copy.*
- **Sub-processors:** OpenAI publishes a list. BusinessPilot must pass the list on to its customers.
- **Location:** by default processing is in the United States. Data residency (storage at rest) is offered in several regions including India. A **12 November 2026 report** says that for **GPT-6 Luna** through Chat Completions and Responses, India requests can also be **processed in India, and that this requires active ZDR**; older analysis said residency was storage only. **The planner uses Luna; the explainer uses Terra, which that report does not mention.** *Confirm with OpenAI sales in writing: eligibility, which models, and whether the explainer's model is covered.*

## 3. Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | Result rows send **customer, product and branch names with amounts** to a US-hosted provider. For sole-proprietor customers this is personal data. The documented rule "PII masked by default" was not enforced for these fields | High | **Partly fixed.** Fields the tenant tags `pii` or `sensitive` are no longer offered to the model, so it cannot plan with them or see their members (ADR-0022). The default template tags none of them, so by default **names still go**. A decision is needed (below). |
| F2 | No confirmed **ZDR**, **DPA** or **residency** arrangement. Default retention at the provider is up to 30 days | High | **Open: account-level, the product owner.** |
| F3 | No per-workspace consent: any workspace's questions would have gone to the provider | High | **Fixed.** A workspace is off by default; an administrator turns it on with an explicit acknowledgement; each change is audited; questions are refused (403) until then; nothing leaves the system while it is off. |
| F4 | The documented conversation retention (180 days) and the stored content did not match the implementation | Medium | **Fixed in docs.** History stores the question and answer for the user, 90 days by default (`CONVERSATION_RETENTION_DAYS`), deletable. Backups keep it longer (disclose). |
| F5 | One API key in the local `.env`, with no spend limit known | Medium | **Open.** Use an OpenAI **project** key with a monthly budget cap; rotate if it was ever shared; keep it in a secret manager for hosted use. It is only visible to the ai-engine container (verified in Compose). |
| F6 | **Prompt injection through data:** a customer or product name in the tenant's data could contain instructions that reach the model through the explainer input | Medium | **Mitigated, not eliminated.** Data sits inside `<data>` tags marked as data; the model has no tools and cannot change what is queried; every number is rendered from the ledger; text with literal digits is rejected. Question-side injection is in the golden set (5 cases); injection through data is not tested yet. |
| F7 | A provider outage or a policy change affects availability, not confidentiality | Low | The provider is behind a port; a switch to another provider or to the dummy is one setting. |
| F8 | Embeddings and retrieval (Milestone 7) will send more content (documents, glossary text) | Info | Not built. Repeat this review before M7. |

## 4. Decisions for the product owner

1. **Customer names in prompts.** Options: (a) accept, with the DPA, ZDR and a clear disclosure (simplest; fine for companies, weaker for sole proprietors); (b) **pseudonymize** member names for the model (the model sees "Customer 3", code swaps the real name back when rendering, which fits the existing placeholder design) for tenants that ask for it; (c) tag customer names `sensitive` for a tenant, which blocks any question that needs them. *Recommendation: (a) for the first pilot with companies, build (b) before onboarding any tenant whose customers are individuals.*
2. **Residency.** Is US processing acceptable for the pilot (disclosed), or must requests be processed in India (needs ZDR and OpenAI's confirmation for both models)? *(counsel)*
3. **Who may switch AI on.** Currently any user with `tenant:manage`. *Recommendation: keep, and show the disclosure text below in the UI at that moment.* (The UI for this is not built; the API is: `PUT /v1/tenant/ai-processing`.)

## Before the first pilot (blockers)

1. OpenAI: request and obtain **ZDR or Modified Abuse Monitoring** for the project that holds the key. *(product owner, OpenAI)*
2. OpenAI: confirm the account is under the **DPA** and keep the signed copy; review the **sub-processor list**. *(product owner)*
3. Decide residency (US with disclosure, or India with ZDR) and get it in writing for both models. *(product owner, counsel)*
4. Use a **project API key** with a **monthly budget limit**; keep training opt-in off. *(product owner)*
5. Decision 1 above, and tag the sensitive fields in the pilot tenant's semantic model.
6. **Customer terms**: BusinessPilot as the customer's processor, OpenAI named as a sub-processor, the purpose, the retention at BusinessPilot (conversations, backups) and at the provider, and cross-border transfer *(counsel; India's DPDP Act obligations for notice, purpose, transfer, breach and erasure)*.
7. The administrator enables AI processing after acknowledging the disclosure (done in code, UI to build).
8. Counsel review of this document and the customer terms (also E10.3).

## Draft disclosure shown before an administrator enables AI processing

> To answer questions, BusinessPilot sends the question you type and a limited set of results from your data (for example customer, product and branch names with amounts, up to 50 rows per answer) to an AI model provider, OpenAI, acting as our sub-processor. We do not send credentials, user or tenant identifiers, or fields you have marked personal or sensitive. [Retention at the provider: per the arrangement in force, for example none beyond processing.] [Processing location: per the arrangement in force.] You can switch this off at any time, and answers will stop. Conversations are kept for 90 days and you can delete them.

## What is implemented as a result of this review

- A per-workspace **AI processing switch**, off by default, audited, enforced before anything is sent ([ADR-0022](../adr/ADR-0022-ai-processing-consent-and-sensitive-fields.md)). Tests: nothing reaches the AI engine while off; acknowledgement required; audit trail; other workspaces unaffected.
- **Exclusion of `pii` and `sensitive` tagged fields** from what the model sees, tested.
- Conversation history with retention and deletion ([ADR-0021](../adr/ADR-0021-conversation-history.md)).
