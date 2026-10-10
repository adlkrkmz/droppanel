---
name: keepa-oxylabs-trace
description: Trace the ListJetGo Keepa collector, verification candidate, amazon_scan_jobs, Oxylabs worker, normalization, apply, Stock Guard, and source-price chain for a specific ASIN or listing.
---

Respect the production architecture.

Main backend:
- 65.108.149.191
- /home/listjetgo/app/backend

Scraper/provider server:
- 31.58.91.138

Routine scanner:
- remote Keepa collector

Verification path:
Keepa collector
→ keepa_verify_candidates
→ amazon_scan_jobs
→ OXYLABS_PRODUCT_PRIMARY
→ scraper Oxylabs worker
→ backend result_payload
→ normalization
→ verified decision
→ apply
→ Stock Guard / pricing / source persistence

Routine cadence:

- sold live positive-stock ASIN: 12h
- standard live positive-stock ASIN: 24h
- Stock Guard zero-stock ASIN: 120h
- truly ended/deleted listing: detached

Shared ASIN uses fastest eligible cadence.

For a trace, identify:

1. ASIN and all active consumers.
2. Collector registry/current observation.
3. Previous commercial fingerprint/baseline.
4. Candidate creation reason.
5. Candidate ID.
6. amazon_scan_job ID/status/provider.
7. Oxylabs worker identity and timestamps.
8. Stored result_payload.
9. Normalized decision.
10. Source validity reason.
11. Apply/outbox status.
12. Source price persistence.
13. Stock Guard action if any.
14. Pricing/profit-protection trigger if any.

Important:

- Do not infer scanner health from disabled legacy planner timestamps.
- Do not move business decisions to the scraper.
- Do not change cadence or policy unless explicitly requested.
- Condition UNKNOWN alone must not invalidate an otherwise healthy source.
- Prime=false alone is not a rejection.
- Preserve current zero-stock and lifecycle rules.
- Distinguish routine collection from verification.

Final report:

COLLECTOR_STATE
CANDIDATE_STATE
AMAZON_SCAN_JOB_STATE
OXYLABS_RESULT
NORMALIZED_DECISION
APPLY_STATE
SOURCE_PRICE_STATE
STOCK_GUARD_STATE
ROOT_CAUSE
