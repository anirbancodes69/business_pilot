# BusinessPilot AI --- New System Setup & Implementation Start Guide

**Purpose:** Use this guide after transferring the BusinessPilot
repository to your personal development system. It explains how to
verify the handover, prepare the local environment, start Claude Code
efficiently, and begin implementation without losing architectural
context or wasting tokens.

------------------------------------------------------------------------

## 1. First principle: verify before building

Do not begin by asking an AI coding assistant to generate the whole
application.

The repository may contain architecture documents, contracts, schemas,
and scaffolding, but that does not mean the application is implemented.
Establish the actual state first.

Keep these distinctions clear:

-   **Documented:** described in Markdown or design files.
-   **Scaffolded:** folders, configuration, or starter code exist.
-   **Implemented:** working code exists.
-   **Verified:** relevant tests or checks have passed.

Never report a feature as implemented or verified based only on
documentation.

## 2. Open and inspect the transferred repository

Open a terminal in the transferred repository:

``` bash
cd /path/to/businesspilot
git status
git log -5 --oneline
```

Check that the expected project files are present:

``` text
CLAUDE.md
CURRENT.md
PRODUCT.md
ARCHITECTURE.md
DECISIONS.md
ROADMAP.md
AI_WORKFLOW.md
docs/
contracts/
schemas/
```

The exact tree may differ. Do not create missing files blindly; first
check whether their content exists under another name.

### Handover safety checks

Before using the repository:

-   Confirm that the repository is authorized for personal use and
    transfer.
-   Check that no employer-owned code, confidential material, customer
    data, credentials, or proprietary prompts were copied without
    permission.
-   Inspect `.env` files, Git history, configuration files, and scripts
    for secrets.
-   Confirm `.gitignore` excludes local secrets, dependency folders,
    build output, logs, and generated files.
-   Do not commit API keys or database passwords.

If the repository contains material that should not have been
transferred, stop and resolve that before proceeding.

## 3. Read the project documents in this order

  -----------------------------------------------------------------------
  Order                   File                    What to establish
  ----------------------- ----------------------- -----------------------
  1                       `CLAUDE.md`             Stable project
                                                  instructions and
                                                  non-negotiable rules

  2                       `CURRENT.md`            Actual current state,
                                                  completed work, gaps,
                                                  and next steps

  3                       `PRODUCT.md`            Target customer,
                                                  problem, product scope,
                                                  and MVP boundaries

  4                       `ARCHITECTURE.md`       System components,
                                                  boundaries, data flow,
                                                  and technology choices

  5                       `DECISIONS.md` and      Accepted decisions
                          relevant ADRs           versus unresolved
                                                  proposals

  6                       `ROADMAP.md`            Milestones and
                                                  implementation sequence

  7                       `AI_WORKFLOW.md`        Model selection,
                                                  context management,
                                                  prompt caching, and
                                                  session practices
  -----------------------------------------------------------------------

Then read only the detailed documents relevant to the first
implementation milestone.

**Important:** If documents disagree, do not silently choose one.
Identify the conflict, point to the affected files, and recommend a
resolution. Keep undecided architecture choices marked as open until
explicitly accepted.

## 4. Prepare the local development environment

BusinessPilot is intended to use a Docker-based development environment.

First inspect the repository for existing setup instructions and
configuration:

``` bash
find . -maxdepth 3 -type f \
  \( -name 'compose.yaml' -o -name 'docker-compose.yml' \
  -o -name 'Dockerfile' -o -name 'Makefile' \
  -o -name '.env.example' \) -print
```

Check available tools:

``` bash
git --version
docker --version
docker compose version
```

If Docker is not installed, install and configure Docker Desktop for
your operating system.

Do not install application runtimes locally unless the project
explicitly requires them. Prefer running application services,
databases, and supporting infrastructure in containers.

### Environment configuration

-   Use `.env.example` to understand required variables.
-   Create a local `.env` only when the project setup requires it.
-   Generate your own local secrets.
-   Never reuse organizational credentials or production secrets.
-   Keep `.env` out of Git.
-   Use local-only databases and test data.

Do not start containers until you have inspected the Compose files and
understand which services and ports they expose.

## 5. Start Claude Code efficiently

From the repository root:

``` bash
claude
```

Use the account and authentication method intended for your personal
development. Check the applicable subscription allowance or API billing
configuration before starting substantial work.

At the beginning of a new task:

1.  Let Claude read `CLAUDE.md`.
2.  Ask it to read `CURRENT.md`.
3.  Ask it to inspect only the architecture documents and source files
    relevant to that task.
4.  Ask for a concise plan before implementation.
5.  Keep one logical task per session.

Use Claude Code's available commands when appropriate:

  Command      Purpose
  ------------ ---------------------------------------------------
  `/context`   Inspect context-window usage
  `/model`     Choose a suitable model
  `/effort`    Adjust reasoning effort, if supported
  `/compact`   Summarize a long session before continuing
  `/clear`     Start an unrelated task with a clean conversation
  `/status`    Inspect session/account information

Claude Code manages prompt caching automatically. Keep stable project
instructions consistent, avoid repeatedly injecting large documents, and
load detailed documentation only when needed. Cached input still
occupies context-window space; caching does not make an oversized
context free.

Follow `AI_WORKFLOW.md` for the full cost-efficient workflow.

## 6. First Claude Code prompt: repository assessment only

Run this before asking Claude to create or modify application code:

``` text
I am setting up BusinessPilot AI on my personal development system.

Read CLAUDE.md and CURRENT.md first. Then inspect the repository structure
and read PRODUCT.md, ARCHITECTURE.md, DECISIONS.md, ROADMAP.md, and
AI_WORKFLOW.md. Read detailed documents only where needed.

Do not modify files, install dependencies, start containers, or write
application code yet.

Report:

1. What is documented, scaffolded, implemented, and verified?
2. Are any expected files or setup instructions missing?
3. Are there conflicts or unresolved architecture decisions?
4. What prerequisites are needed to run the project locally?
5. What is the smallest sensible first implementation milestone?
6. Which exact files and tests would that milestone involve?

Base your assessment on the actual repository. Do not assume that a
documented feature already exists in code. Keep the report concise.
```

Review the response. Correct any inaccurate assumptions before
proceeding.

## 7. Agree the first implementation milestone

Use the assessment to confirm a small, testable milestone.

A sensible proposed sequence is:

### Milestone 0 --- Repository and local development foundation

-   Confirm repository structure and Git hygiene.
-   Confirm Docker Compose strategy and local environment variables.
-   Establish basic developer commands and setup documentation.
-   Verify that the empty or starter services can build and run, if they
    exist.

### Milestone 1 --- Application foundation

Subject to the architecture decisions being confirmed:

-   Create the initial service/application structure.
-   Configure PostgreSQL and database migrations.
-   Define the tenant and workspace domain model.
-   Establish authentication.
-   Establish server-side authorization boundaries.
-   Add health checks and structured logging.
-   Add automated tests for critical boundaries.

### Milestone 2 --- Tenant isolation and configuration

-   Implement tenant-scoped data access.
-   Add PostgreSQL Row-Level Security if that is the accepted design.
-   Add tenant-aware configuration and permission checks.
-   Write cross-tenant access tests before adding business-data
    features.

### Milestone 3 --- First data connector

-   Select one supported source for the MVP.
-   Implement the connector contract and schema discovery.
-   Add secure credential handling.
-   Add a controlled read-only connection and validation.
-   Test failure handling and access boundaries.

### Milestone 4 --- First useful business question

-   Define a small, approved semantic model.
-   Implement a restricted query-planning and SQL-validation flow.
-   Execute read-only structured queries.
-   Generate answers grounded in query results.
-   Show data source and freshness information.
-   Evaluate correctness against known test cases.

This is a proposed sequence, not a claim that these decisions or
components have already been implemented. Confirm the first milestone
against the actual repository and open ADRs.

## 8. Implementation loop: one small unit at a time

For each task, use this workflow:

1.  **Scope:** Define one outcome and acceptance criteria.
2.  **Inspect:** Read only relevant docs and code.
3.  **Plan:** Identify files, design impact, risks, and tests.
4.  **Approve:** Resolve important open decisions before coding.
5.  **Implement:** Make the smallest coherent change.
6.  **Verify:** Run relevant tests, build checks, and security checks.
7.  **Review:** Inspect the diff and ensure unrelated files were not
    changed.
8.  **Document:** Update `CURRENT.md`; update an ADR only when a
    decision changes.
9.  **Commit:** Create a focused Git commit after verification.

Do not combine unrelated milestones into one large prompt.

### Reusable implementation prompt

``` text
Implement one focused BusinessPilot task.

Task:
[Describe the specific outcome.]

Acceptance criteria:
[List observable conditions that must be met.]

Relevant documentation:
[List only the relevant files.]

Instructions:
- Inspect the existing implementation before changing it.
- Follow CLAUDE.md and AI_WORKFLOW.md.
- Preserve tenant isolation and server-side authorization.
- Do not trust tenant IDs or permissions supplied by the client.
- Do not let an LLM make authorization decisions.
- Avoid unrelated refactoring and unnecessary dependencies.
- If a required architecture decision is unresolved, stop and explain
  the options rather than silently choosing one.

Before coding, provide a concise plan and list the files to change.
After implementation, run relevant tests, review the Git diff, and
report exactly what changed and what remains unverified.
Update CURRENT.md only when the actual project status changes.
```

## 9. Maintain project continuity

At the end of each substantial work session, ensure `CURRENT.md`
records:

-   Current milestone and status.
-   What was actually implemented.
-   Tests and checks that passed or failed.
-   Known defects and limitations.
-   Decisions made and ADR references.
-   Open questions.
-   The single recommended next task.

Keep it factual and concise. Do not turn it into a transcript of the AI
conversation.

Commit meaningful work:

``` bash
git status
git diff
git add <specific-files>
git commit -m "feat: <short description>"
```

Avoid `git add .` if you have not checked for secrets, generated files,
or unrelated changes.

## 10. Definition of ready for the next milestone

Do not move to the next milestone until:

-   The current milestone's acceptance criteria are met.
-   Relevant tests pass, or failures are explicitly documented.
-   Tenant isolation and authorization tests are included where
    applicable.
-   The diff has been reviewed.
-   Documentation reflects the real implementation state.
-   No unresolved decision is being hidden by an implementation
    assumption.

------------------------------------------------------------------------

## Final operating principles

1.  Build a commercial product, not a demo that only works on a
    developer's machine.
2.  Validate customer value before expanding product scope.
3.  Prioritize security, tenant isolation, and data correctness from the
    beginning.
4.  Keep the architecture modular, but avoid premature microservices and
    infrastructure complexity.
5.  Use structured storage for reliable business calculations; use
    vector retrieval for appropriate semantic context.
6.  Treat AI-generated SQL and outputs as untrusted until validated.
7.  Optimize for useful, verified progress per token---not minimum token
    count.
8.  Keep organizational and personal development environments,
    credentials, and intellectual property appropriately separated.

**The immediate next action:** open the transferred repository, run the
repository-assessment prompt in Section 6, review the findings, and
agree the first milestone before writing application code.
