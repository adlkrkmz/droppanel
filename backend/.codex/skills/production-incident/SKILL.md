---
name: production-incident
description: Investigate a live ListJetGo production incident safely. Use when something that was working is now failing, a recent change may have caused a regression, production behavior differs from expected behavior, or an exact root cause is needed before making a fix.
---

You are investigating a live ListJetGo production incident.

Follow this order:

1. Read AGENTS.md first.
2. Treat the task as read-only until the exact failure path is proven.
3. Reproduce or identify the exact failing record, request, job, item, store, or process.
4. Trace the real runtime path:
   - entrypoint
   - service/function chain
   - database reads/writes
   - external API calls
   - guards
   - retries/idempotency
   - final persistence
5. Inspect relevant logs, DB rows, audit records, and source code.
6. Separate:
   - symptom
   - exact root cause
   - collateral effects
7. Do not guess.
8. Do not broaden into unrelated cleanup.
9. If a recent change caused a regression:
   - contain it first,
   - restore the previously working business path safely,
   - then address secondary issues.
10. Before any mutation, prove:
   - exact target
   - ownership/store/account identity
   - intended state
   - mutation path
   - safety/idempotency
11. If the requested fix is safe and sufficiently proven, make the smallest possible change.
12. Test only the affected path unless broader testing is required.
13. Never report success without direct evidence.

Final report must contain:

ROOT_CAUSE
EXACT_CODE_PATH
CHANGE_MADE
TEST_RESULT
DEPLOY_RESULT if applicable
HEALTH_RESULT if applicable
REMAINING_BLOCKER if any

If not completed, say explicitly:
TASK_COMPLETED = false
