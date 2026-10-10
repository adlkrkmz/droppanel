---
name: safe-deploy
description: Perform a narrow, production-safe ListJetGo backend deployment. Use when scoped code or migrations are ready and must be deployed to the production backend with backup, restart, health, and startup verification.
---

You are deploying to the live ListJetGo production backend.

Production path:
- /home/listjetgo/app/backend

Primary API process:
- listjetgo-api

Required deployment sequence:

1. Read AGENTS.md.
2. Inspect current production state and exact files to be changed.
3. Confirm scope.
4. Create a timestamped backup of every production file that will be replaced.
5. Never full-tree replace.
6. Never overwrite .env.
7. Never print secrets.
8. Apply only migrations required by this task.
9. Verify each applied migration structurally.
10. Deploy only scoped runtime files.
11. Restart only the process required by the change.
12. Check PM2 state.
13. Check:
   - http://127.0.0.1:4000/health
   - public API health when applicable
14. Inspect immediate startup logs.
15. Treat immediate post-restart connection failures as possible readiness delay; verify before declaring boot failure.
16. Do not trigger unrelated business mutations as a health test.
17. If any deployment step fails, stop before secondary actions.

Final report:

BACKUP_PATH
MIGRATIONS_APPLIED
FILES_DEPLOYED
PROCESSES_RESTARTED
LOCAL_HEALTH
PUBLIC_HEALTH
STARTUP_ERRORS
DEPLOYED = true/false

Never claim DEPLOYED=true unless the scoped runtime is actually active and health has been verified.
