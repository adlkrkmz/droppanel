# ListJetGo Production Backend — Agent Instructions

You are working directly on the ListJetGo production backend.

Production path:
- /home/listjetgo/app/backend

Primary production API process:
- listjetgo-api

Health endpoint:
- http://127.0.0.1:4000/health

This is a live production system. Treat every change as production-critical.

## 1. NEVER GUESS

Do not invent architecture, database state, runtime behavior, API behavior, deployment state, or previous results.

If a fact is not verified:
- inspect the code,
- inspect the database,
- inspect logs,
- inspect existing audit/event records,
- or explicitly say it is not verified.

Never present an assumption as a fact.

## 2. NEVER CLAIM WORK THAT WAS NOT ACTUALLY COMPLETED

Do not say:
- deployed,
- fixed,
- tested,
- restarted,
- migrated,
- reprocessed,
- verified,
- succeeded,
- healthy

unless the corresponding action actually happened and you have direct evidence.

If a task was only partially completed, say exactly what remains incomplete.

If execution was blocked, say BLOCKED and explain the exact blocker.

## 3. UNDERSTAND THE EXISTING FLOW BEFORE EDITING

Before changing code:
1. identify the actual entrypoint,
2. trace the current call path,
3. identify persistence points,
4. identify external side effects,
5. identify existing guards,
6. identify retry/idempotency behavior.

Do not add a second implementation when an existing service/path should be reused.

Do not refactor unrelated code while fixing a scoped issue.

## 4. PRODUCTION SAFETY

Default to read-only investigation first for production incidents.

Before a production mutation:
- prove the target,
- prove ownership/store/account identity,
- prove the intended current state,
- prove the mutation path,
- preserve idempotency.

Never manually alter production business state just to make a workflow pass unless the user explicitly authorized that exact DB mutation.

Never hide or bypass an existing safety guard to force an operation through.

## 5. LISTJETGO ARCHITECTURE — IMPORTANT

Main backend:
- 65.108.149.191
- /home/listjetgo/app/backend

Scraper/provider server:
- 31.58.91.138

Main backend owns:
- PostgreSQL business state
- amazon_scan_jobs
- source normalization
- source policy
- Stock Guard
- pricing/profit protection
- guarded eBay mutations

Scraper server owns provider execution such as:
- Keepa collector
- Oxylabs provider worker

Do not move business decisions or eBay mutations to the scraper server.

## 6. SHARED BACKEND SAFETY

The backend is shared by multiple ListJetGo features.

Do not break unrelated:
- eBay listings
- orders
- scheduler
- assisted order
- Gmail/mailbox
- customer service
- finance
- Etsy-related shared backend behavior

Make the smallest safe change.

## 7. EBAY PRICE UPDATE RULE

For buyer-visible eBay price changes:

- Inventory offer state alone is NOT authoritative success.
- Trading GetItem buyer-visible price is the final success authority where that flow applies.
- Local ebay_price must not be persisted as success unless the authoritative live-price verification succeeds.
- Do not weaken store/account/SKU/item/offer mapping guards.
- Provider HTTP success alone does not prove business success.
- Parse and retain eBay-level acknowledgement/error data when available.

## 8. KEEPA / OXYLABS / STOCK GUARD

Do not change these systems unless the task explicitly requires it.

Current routine Keepa lifecycle policy:
- sold live positive-stock ASIN: 12h
- standard live positive-stock ASIN: 24h
- Stock Guard zero-stock ASIN: 120h
- truly ended/deleted listing: detach from monitoring

Shared ASIN uses the fastest eligible cadence.

Do not change pricing formulas, Keepa cadence, Oxylabs source policy, or Stock Guard rules as collateral work.

## 9. DEPLOY RULES

Production backend is not assumed to behave like a clean git deployment.

For targeted deploy work:
- inspect current dirty state first,
- back up every production file that will be replaced,
- deploy only scoped files,
- do not full-tree replace,
- do not overwrite .env,
- do not print secrets,
- apply only the required migration,
- restart only the required process,
- verify local health,
- verify public health when applicable,
- inspect immediate startup logs.

A temporary health failure immediately after restart may be readiness delay; verify before declaring a boot failure.

## 10. DATABASE RULES

Do not print credentials.

Do not source .env blindly.

Before writing SQL:
- inspect schema,
- verify exact rows and scope,
- prefer application-level operations for business mutations.

Historical audit records should remain intact unless deletion is explicitly required.

## 11. TESTING

For a bug fix:
- reproduce or prove the failure shape,
- add focused validation/fixtures when practical,
- validate the exact affected path,
- do not spend time repairing unrelated pre-existing type errors.

Do not claim full repository validation if only focused tests ran.

## 12. REPORTING

Final reports must distinguish clearly:

- VERIFIED FACT
- CHANGE MADE
- TEST RESULT
- DEPLOY RESULT
- BLOCKER / REMAINING WORK

Never convert an intention into a completed result.

Use exact IDs, timestamps, statuses, paths, and error messages when available.

## 13. SCOPE DISCIPLINE

Do only the requested job.

Do not:
- add unrelated features,
- redesign architecture without need,
- perform broad cleanup,
- mass-reprocess records unless explicitly authorized,
- change business formulas to make a test pass.

If the correct fix requires broader scope, explain why before doing it.

## 14. INCIDENT PRIORITY

When a newly introduced change causes a production regression:

1. stop expanding scope,
2. contain the regression,
3. establish exact root cause,
4. restore the previously working business path safely,
5. then continue secondary cleanup or legacy reconciliation.

Production functionality takes priority over historical cleanup.

## 15. OPENAI / CODEX DOCUMENTATION

When working on OpenAI API, ChatGPT, Codex, plugins, MCP, or OpenAI platform behavior:
use the OpenAI developer documentation MCP server when available rather than relying on memory.

## 16. COMMUNICATION STYLE

Be concise and operational.

Do not ask unnecessary questions when the answer can be verified from the repository or production evidence.

Do not perform speculative analysis.

When blocked, state exactly:
- what was attempted,
- what evidence was found,
- why execution stopped,
- what single next action is required.

## 17. AUTOMATIC TASK ROUTING

At the start of every task, evaluate the available project Skills and connected MCP/tools. Never wait for the user to name them. Select the minimum relevant Skill set, combine Skills when the task spans concerns, and use MCP/tools only when they materially improve verification or execution. Do not mention routing unless it is useful to the user.

Route tasks as follows:

- production incident, live regression, unexplained failure: `production-incident`
- deploy, restart, production file rollout: `safe-deploy`
- eBay listing price, profit protection, buyer-visible price mismatch: `ebay-price-debug`; also `ebay-api-trace` when API mutation or readback matters
- Keepa, Oxylabs, verification, source price, stock evidence: `keepa-oxylabs-trace`
- DB evidence, counts, timestamps, historical row inspection: `db-readonly-audit`
- shared-code impact, caller impact, before/after safety: `regression-check`
- production PM2, port, health endpoint, process, or log issue: `production-health`
- Trading, Inventory, Fulfillment, exact eBay request/response trace: `ebay-api-trace`
- manual path works but automatic path fails, or vice versa: `manual-vs-automatic-path`
- migration creation, change, or application: `migration-safety`

Tool routing:

- browser, UI, or public-page verification: Playwright MCP
- OpenAI, Codex, API, or product documentation: OpenAI Developer Docs MCP
- GitHub history, commit, diff, PR, CI, branch, or repository comparison: GitHub connector/tool when available

Use `.codex/skills/task-router/SKILL.md` as the lightweight routing procedure. Preserve every authorization and safety boundary in this file; routing never grants permission for deployment, mutation, or broader scope.
