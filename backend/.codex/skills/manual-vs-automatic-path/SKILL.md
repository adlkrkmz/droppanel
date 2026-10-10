---
name: manual-vs-automatic-path
description: Compare ListJetGo manual UI actions with automatic worker/scheduler paths. Use when a manual button works but automation fails, automation works but manual action fails, or both should share a service but behavior differs.
---

Read AGENTS.md first.

For the exact feature/problem, trace both paths separately.

MANUAL PATH

Identify:

1. UI page/component/action.
2. Frontend request.
3. Backend route/controller.
4. Service/function chain.
5. DB reads/writes.
6. External API calls.
7. store/account context.
8. guards.
9. retries/idempotency.
10. final persistence and UI feedback.

AUTOMATIC PATH

Identify:

1. scheduler/worker/event trigger.
2. job/queue/outbox/candidate if applicable.
3. worker/service entrypoint.
4. service/function chain.
5. DB reads/writes.
6. external API calls.
7. store/account context.
8. guards.
9. retries/idempotency.
10. final persistence/activity state.

Then compare:

- first shared function
- first divergence
- different inputs
- different store/account resolution
- different transaction boundaries
- different retries
- different guards
- different persistence timing
- different success criteria
- different error handling

Do not assume both paths share code because they perform the same business action.

Do not duplicate logic to make one path match the other unless the shared service boundary is proven.

Final report:

MANUAL_ENTRYPOINT
AUTOMATIC_ENTRYPOINT
FIRST_SHARED_PATH
FIRST_DIVERGENCE
INPUT_DIFFERENCES
GUARD_DIFFERENCES
PERSISTENCE_DIFFERENCES
SUCCESS_CRITERIA_DIFFERENCES
ROOT_CAUSE
SAFE_MINIMAL_FIX
