# Production stock operations

Last reviewed: 2026-09-09 UTC

## Deployed scope

- Quantity mutations use a server-owned source allowlist.
- `manual_listing` and `sold_item_restock` are enabled.
- `automatic_zero` remains disabled.
- The global eBay simulation setting remains unchanged; price, publish, and other non-quantity mutation paths remain closed. Manual End is separately enabled by the server-owned EBAY_LIVE_MANUAL_END_ENABLED=true gate.
- Legacy monitor stock updates now use the same quantity helper and cannot return synthetic simulation success.
- Panel single and bulk stock actions only update/count a result when it is not simulated; failed optimistic quantity changes are not applied.
- Stock Alerts are hidden through `stock_review_items.feed_hidden_at`; rows, audit history, orders, catalog state, verification tasks, and idempotency records are preserved.
- Stock Alerts reads use a session-local PostgreSQL JIT-off query path; the global database JIT setting was not changed.
- Count and page-list reads are started in parallel; filters, page limits, and store/workspace ownership predicates remain unchanged.
- Store switching aborts superseded alert requests, ignores stale responses, clears the old store rows immediately, and scopes loading state to the current request.
- Manual End now has its own server-side mutation gate and does not inherit the global quantity/price simulation decision. The deployed API gate is enabled by the production environment; no End request was issued during this deployment.
- Single/bulk End now keeps per-item failures, limits bulk eBay concurrency to three, reports unknown timeout results without deleting local rows, and cannot leave the panel modal in an indefinite `Removing…` state after a rejected request.
- Listings store changes abort the previous list request, clear old-store rows, and ignore stale results. End success closes the modal after the server response; list/store refresh runs separately.
- Dashboard’s measured Stock Alerts count path uses the session-local JIT-off query helper; the global database JIT setting was not changed.

## Stock Alerts cleanup

Scope was verified from S2 (`apexmarketfinds`) owner membership. Target stores were S1, S2, and S3 in the same workspace only.

- Fixed cutoff: `2026-09-09 07:36:13.349882+00`
- S1: 8,092 rows
- S2: 9,425 rows
- S3: 4,187 rows
- Total hidden from feed: 21,704 rows
- Status totals: ignored 12,890; actioned 7,363; failed 1,136; pending 315
- Reversible backup: `var/stock-alert-cleanup-backups/stock-alerts-20260909073613.json`
- Migration: `migrations/066_stock_alert_feed_cleanup.sql`

No eBay, listing, order, or replay operation was started by the cleanup.

## Stock Alerts performance validation

- Production target stores were measured under the same `status=all`, `risk=all`, page 1, limit 50 conditions.
- Before: S1 3.63–5.78s, S2 3.62–4.88s; direct S3 EXPLAIN count/list was 1.21s/2.18s.
- After: S1 9–46ms, S2 8–14ms, S3 8–12ms in the application service.
- After JIT-off EXPLAIN execution: count 0.16–0.92ms and list 0.17–0.54ms across S1/S2/S3.
- The target workspace currently has zero visible operational rows in all three stores, so no browser transition time was claimed. Existing non-target production data was used read-only to verify page 1/page 2 separation and store isolation.
- The measured delay was PostgreSQL JIT plan compilation for the shared visibility/provenance predicate, not a feed row scan or a new index requirement.

## End and panel performance validation

- S2 / `apexmarketfinds` / catalog 13007 was verified read-only: active store id 4, eBay item and offer identifiers present, current status `live`.
- Before End deploy: the latest S2 single and bulk attempts both audited HTTP 502 `Could not end listing`; the service stopped at the global `EBAY_SIMULATION=true` guard before the eBay adapter.
- Listings service timing after the panel/API changes: S2 p50 42–44ms, p95 48–57ms (five sequential application-service reads; no browser session was available).
- Dashboard timing after the measured JIT fix: p50 174ms, p95 226ms. Before the fix, the same service was p50 1,768ms, p95 1,976ms; the underlying Stock Alerts count was 646ms with JIT and 3.7ms with JIT disabled.
- Stores timing was 199ms p50 / 279ms p95 in one run before the End deploy and 271ms p50 / 757ms p95 in the later run; this variance is not attributed to the End change.
- Local health probes after deploy: API 200 in 4ms, panel `/app/listings` 200 in 186ms. These are server probes, not real user store-transition measurements.

## Normal-flow follow-up

- Desktop ambiguous/unread observations must not produce a price or stock decision: server-side rejection/classification is present; Windows runtime behavior is not verified here.
- Desktop must stop after ten consecutive unread products: Windows behavior remains unverified and is an open task.
- Desktop payload must be evaluated server-side without trusting client decisions: verified in server code and observed accepted `VALID_SOURCE` events; Windows end-to-end continuity remains open.
- Automatic price protection remains disabled/closed and must stay that way until its normal-flow review is complete.
- Automatic stock zeroing remains disabled by both the existing guards and the source allowlist; do not enable before normal-flow checks.
- Windows Desktop Agent continuous operation cannot be certified from this server alone. Server heartbeat proves recent connectivity, not Windows process persistence.
- The public Amazon worker has observed database connection timeouts and browser OBSERVE_HARD_TIMEOUT/page-crash self-restarts; this requires separate investigation. No worker restart was performed in this task.

## Bulk quantity Working-state incident — 2026-09-09

- Scope confirmed read-only: active S2 store id `4`, workspace `c53d6072-d623-4c15-ad1e-4ee18fe714a3`, store code `S2`, name `apexmarketfinds`, owner `ismlkrkmz54@gmail.com`. The inactive id `3` store was excluded.
- Historical batch `afca8bf0-3bfc-4ce3-b9e6-c715352a0c10` contained exactly 47 `app.listings.set_quantity` audit items, requested quantity 1. Start trace: `2026-09-09T09:45:26.786Z`; first item audit: `09:45:29.754Z`; last eBay HTTP 200 / last item log: approximately `09:47:22Z`; last item audit: `09:47:22.609Z`.
- Reconciled result: eBay HTTP/mutation acceptance was 47/47, local catalog quantity is 1 for 47/47 exact target rows, explicit known failures 0, and audit rows left pending 0. The old path has no explicit eBay read-back verification record, so independently recorded eBay verification is 0/47 and 47/47 are accepted-but-read-back-unverified; user-visible checks were not used as batch success evidence.
- Measured old serial processing window was at least 112.855s from request trace start to last item audit. Old HTTP response completion could not be measured because the pre-fix middleware had no response-finish telemetry and the historical reverse-proxy access log was not readable. No eBay timeout, retry hang, DB lock, or per-item exception was present in the evidence.
- Root cause: the old panel bulk handler awaited a potentially non-settling/rejected fetch without `try/catch/finally`; the server also processed the 47 items serially and had no bounded eBay deadline or per-item uncertain outcome. Both quantity buttons were bound to one boolean, so a stuck request made both show `Working…`; the panel did not apply confirmed per-item results before its refresh path.
- Fix deployed: bounded concurrency of 3; per-item succeeded/failed/uncertain outcomes and audits; 15s eBay mutation/verification deadline plus one 8s read-only reconciliation on timeout, with no automatic mutation replay; local-write uncertainty is preserved; lifecycle hooks are best effort; batch completion audit/log; panel `try/catch/finally`, operation-specific button state, finite 300s bulk client guard, stale-store protection, no resubmit guidance, confirmed-row application, and one non-authoritative refresh. Single-listing quantity actions now also finalize on error/timeout and ignore stale-store results. Quantity request response-finish telemetry was added. Existing manual listing/sold item restock gates remain unchanged; automatic zero, automatic price, Desktop, and Amazon worker scopes were not changed.
- Validation without production mutation: `scripts/quantityBulkSafetyFixtures.ts` passed 47/47, peak concurrency 3, exception isolation, uncertain timeout, partial success, refresh failure, stale store, and duplicate click cases. Focused backend TypeScript check passed; panel `npm run typecheck` and `npm run build` passed.
- Deploy: panel rebuilt and `listjetgo-panel` restarted; `listjetgo-api` restarted after confirming no active quantity bulk request, then restarted once more to load response-finish telemetry. Final PM2 status was online for both affected services; API `/health` returned 200 and panel `/app/listings` returned 200. No quantity mutation or replay was issued by this investigation/deploy.
- Before/after production duration: no after-duration claim is made because the requested new real batch was not run. Future batches will emit per-item and `durationMs` completion telemetry. Panel build time was not used as an operation-duration comparison.

The normal-flow follow-up above remains open: the last 100 Desktop checks and return to the normal automatic flow are not completed by this incident fix.
