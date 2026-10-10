---
name: db-readonly-audit
description: Perform a read-only production database audit for ListJetGo. Use when exact rows, schema relationships, counts, timestamps, or historical evidence must be verified without mutating business state.
---

Read AGENTS.md first.

Rules:

1. READ-ONLY by default.
2. Inspect schema before writing queries.
3. Never guess column meaning from names alone.
4. Use exact IDs whenever available.
5. Prefer narrow queries before broad scans.
6. Record:
   - table
   - key columns
   - exact filter
   - timestamps
   - counts
7. Distinguish current-state tables from append-only audit/history tables.
8. Do not source .env blindly.
9. Do not print credentials.
10. Do not run UPDATE/DELETE/INSERT unless explicitly authorized.
11. If evidence is incomplete, say so.
12. Never infer historical state from current rows unless retention behavior is proven.

Final report:

TABLES_INSPECTED
QUERY_SCOPE
VERIFIED_ROWS
COUNTS
TIMESTAMPS
EVIDENCE_LIMITATIONS
NO_DB_MUTATION = true
