# BusinessPilot AI — AI-Assisted Development Workflow

## 1. Objective

Use AI coding assistants efficiently while minimizing unnecessary token consumption, context usage, and development cost.

This workflow applies to Claude Code and other AI coding assistants.

## 2. Model Selection

Use models according to task complexity:

| Task | Model strategy |
|---|---|
| Complex architecture and security decisions | Strong reasoning model |
| Regular feature development | Balanced coding model |
| Simple documentation and formatting | Fast, economical model |
| Test generation and basic refactoring | Balanced or economical model |

Do not use expensive models for routine tasks without justification.

## 3. Context Management

- Keep CLAUDE.md concise.
- Treat CLAUDE.md as the project entry point.
- Read CURRENT.md at the beginning of a new task.
- Load only documentation relevant to the task.
- Avoid scanning the entire repository unnecessarily.
- Do not repeatedly paste architecture documents into prompts.
- Avoid unnecessary conversation history.
- Use focused sessions for independent tasks.

## 4. Prompt Caching

This section covers the coding assistant's caching during development. BusinessPilot's own runtime caching (provider prompt caching, exact and semantic caches) is a product design, documented in [AI_ENGINEERING.md](AI_ENGINEERING.md#5-caching).

- Keep stable project instructions consistent.
- Avoid frequently changing CLAUDE.md.
- Keep reusable instructions before task-specific content.
- Avoid unnecessarily changing model and tool configurations.
- Allow the coding assistant to use its built-in prompt caching.
- Do not implement custom prompt caching unless a demonstrated requirement exists.
- Remember that cached input still occupies context-window space.

## 5. Development Session Lifecycle

For every substantial task:

1. Inspect CLAUDE.md and CURRENT.md.
2. Identify relevant architecture documents.
3. Inspect only relevant source files.
4. Prepare a concise implementation plan.
5. Implement one logical unit.
6. Run relevant tests.
7. Review the Git diff.
8. Update CURRENT.md when meaningful progress occurs.
9. Update ADRs when architecture decisions change.
10. Commit the completed milestone.

## 6. Session Management

Use the coding assistant's available context-management commands.

For Claude Code:
- /context — inspect context consumption.
- /compact — summarize a long session.
- /clear — start an unrelated task.
- /model — select a suitable model.
- /effort — adjust reasoning effort.
- /status — inspect session information.

Start a fresh session when moving to a substantially unrelated task.

## 7. Repository Exploration

- Prefer targeted file inspection.
- Avoid repeatedly reading generated files, dependencies, build outputs, and logs.
- Use existing documentation as the source of architectural context.
- Do not create duplicate documentation.
- Ask before performing broad repository rewrites.

## 8. Agent and Tool Usage

- Use subagents only for independent tasks that justify additional usage.
- Avoid parallel agents for simple implementation tasks.
- Do not repeatedly invoke tools without a clear purpose.
- Prefer deterministic scripts and tests over unnecessary LLM reasoning.

## 9. Documentation and Handover

Maintain:

- CLAUDE.md — stable project instructions.
- CURRENT.md — current implementation status.
- AI_WORKFLOW.md — AI-assisted development and cost-management rules.
- DECISIONS.md — accepted and unresolved architecture decisions.
- ROADMAP.md — implementation milestones.

At the end of a substantial session, ensure CURRENT.md reflects the actual repository state.

Never claim that work is complete unless verified.

## 10. Cost and Security Rules

- Never expose API keys, credentials, or customer data in prompts.
- Do not use organizational accounts, repositories, or proprietary resources without authorization.
- Do not enable paid API fallback without understanding its billing implications.
- Check account usage and applicable subscription limits.
- Do not optimize token cost at the expense of correctness, security, or maintainability.

## 11. Core Principle

Optimize for useful work completed per token, not minimum token count.

Prefer focused context, stable instructions, small implementation units, and verified outcomes.