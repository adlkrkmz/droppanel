---
name: production-health
description: Check ListJetGo production health safely. Use for PM2, port, API, DB, startup, readiness, and recent error verification without changing business state.
---

Read AGENTS.md first.

Check in this order:

1. PM2 status for relevant processes.
2. Required process uptime/restart count.
3. Port 4000 listener.
4. Local health:
   http://127.0.0.1:4000/health
5. Public health when applicable.
6. DB/API health response.
7. Recent startup/runtime logs.
8. Resource symptoms only if relevant:
   memory, load, disk.
9. Distinguish:
   - boot failure
   - readiness delay
   - process crash loop
   - upstream/proxy failure
   - DB connectivity issue
   - unrelated transient error

Do not restart anything unless explicitly asked.

Final report:

PM2_STATUS
PORT_4000
LOCAL_HEALTH
PUBLIC_HEALTH
DB_HEALTH
API_HEALTH
RECENT_ERRORS
ROOT_CAUSE_IF_UNHEALTHY
NO_RESTART = true
