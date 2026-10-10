---
name: regression-check
description: Assess the blast radius of a proposed or completed ListJetGo code change. Use before deploy or after a regression to identify callers, shared paths, affected modules, and focused tests.
---

Read AGENTS.md first.

For the changed file/function:

1. Identify direct callers.
2. Identify shared service consumers.
3. Identify side effects.
4. Identify DB writes.
5. Identify external API calls.
6. Identify worker/manual/UI paths sharing the code.
7. Identify guards and retries.
8. Identify unrelated modules that must not be affected.
9. Determine the minimum focused regression test set.
10. Do not propose broad refactors unless required.

Special attention:

- manual vs automatic flows
- eBay listing/order/shared backend overlap
- Keepa/Oxylabs/Stock Guard boundaries
- scheduler/worker reuse
- store/account identity
- idempotency

Final report:

CHANGED_PATH
DIRECT_CALLERS
SHARED_CONSUMERS
SIDE_EFFECTS
RISK_AREAS
FOCUSED_TESTS_REQUIRED
SAFE_TO_DEPLOY = true/false
