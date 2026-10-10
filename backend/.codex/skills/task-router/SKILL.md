---
name: task-router
description: Select the minimum relevant ListJetGo project Skills and verification tools before work begins, especially when a request spans production, eBay, provider, database, deployment, UI, documentation, or GitHub concerns.
---

# Task Router

Use this project-scoped meta-skill before substantive work. It selects procedures and tools; it contains no business logic and performs no code or state mutation itself.

## Route the task

Classify the request into one or more domains:

- `incident`
- `deployment`
- `ebay_price`
- `ebay_api`
- `keepa_oxylabs`
- `database`
- `regression`
- `health`
- `manual_vs_auto`
- `migration`
- `browser_ui`
- `openai_docs`
- `github`

Select the minimum relevant existing Skill set using the routing table in `AGENTS.md`. Use multiple Skills only when the request genuinely spans domains.

If the request is ambiguous, inspect read-only evidence first. Do not guess. Ask the user only when evidence cannot resolve an ambiguity that materially changes the work.

For critical production work:

- combine `production-incident` with the relevant domain Skill;
- add `regression-check` before code changes when shared callers or before/after safety matter;
- use `migration-safety` whenever a schema migration is involved;
- use `safe-deploy` only when an actual deployment, restart, or production rollout is requested.

## Choose tools

- Use Playwright MCP for browser-visible truth.
- Use OpenAI Developer Docs MCP for authoritative OpenAI product and API documentation.
- Use the GitHub connector/tool for repository, history, branch, diff, PR, or CI truth.
- Do not use tools that do not materially improve verification or execution.

Routing does not expand authorization. Preserve `AGENTS.md`: never guess or claim unverified completion; investigate production read-only first; keep changes minimal and scoped; protect shared backend and eBay behavior; and verify relevant outcomes after changes.
