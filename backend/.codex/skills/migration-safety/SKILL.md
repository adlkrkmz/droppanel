---
name: migration-safety
description: Review, apply, and verify a ListJetGo production database migration safely. Use when adding or changing tables, columns, indexes, constraints, enums, or migration-backed audit structures.
---

Read AGENTS.md first.

Before applying a migration:

1. Identify the exact migration file.
2. Inspect current production schema.
3. Check whether:
   - table already exists
   - column already exists
   - index already exists
   - constraint already exists
   - enum/value already exists
4. Check for naming collisions.
5. Check compatibility with existing production rows.
6. Check null/default behavior.
7. Check lock/rewrite risk.
8. Check index creation cost.
9. Check whether the migration is idempotent or intentionally one-time.
10. Check application compatibility before and after migration.
11. Never apply unrelated migrations.
12. Never use destructive rollback unless explicitly authorized.

When applying:

- do not print credentials
- do not source .env blindly
- use the established production DB connection method
- capture exact success/failure evidence
- stop on error

After applying:

1. verify schema objects directly
2. verify indexes/constraints
3. verify expected defaults/nullability
4. run a narrow read-only smoke query
5. do not assume migration success from command exit alone

If the application also changes:
- migration must be compatible with deployment order
- avoid a window where old code cannot run against new schema unless explicitly planned

Final report:

MIGRATION_FILE
PRECHECK_RESULT
COLLISION_CHECK
DATA_COMPATIBILITY
LOCK_RISK
APPLY_RESULT
POST_APPLY_SCHEMA_VERIFIED
SMOKE_QUERY_RESULT
ROLLBACK_REQUIRED = true/false
SAFE_TO_CONTINUE_DEPLOY = true/false
