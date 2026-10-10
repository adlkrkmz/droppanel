# Amazon scan server (not enabled in production yet)

Packaged remote worker (copy via Windows SSH alias `listjetgo-scan`):
`dist/amazon-scan-worker-1.0.5.tar.gz` — README is inside the archive.

Do not put DATABASE_URL or eBay OAuth on this host.

## Process
- Routine: `AMAZON_SCAN_WORKER_ROLE=ROUTINE ./scripts/run-amazon-scan-worker.sh A`
- Confirm slot: `AMAZON_SCAN_WORKER_ROLE=CONFIRM ./scripts/run-amazon-scan-worker.sh C`

## Required env
- AMAZON_SCAN_API_BASE=https://api.example.internal
- AMAZON_SCAN_WORKER_TOKEN (same 32+ char token as API)
- AMAZON_PUBLIC_US_ZIP=10001
- AMAZON_PUBLIC_WORKER_SLOT=A
- AMAZON_PUBLIC_WORKER_COUNT matching slots

## API flags (cutover, currently leave false except auth worker)
- AMAZON_BROWSER_PLANNER_ENABLED
- AMAZON_SCAN_REMOTE_PROTOCOL_ENABLED
- AMAZON_SCAN_REMOTE_WORKERS_ENABLED (pauses local public claim)
- AMAZON_MUTATION_CONFIRM_READ
- AMAZON_SCAN_APPLY_PROCESSOR_ENABLED
- AMAZON_KEEPA_ROUTINE_ACTIONS_DISABLED (Keepa off-ramp for this flow)

Price-up and stock-zero candidates always enqueue a fresh CONFIRM job in apply code.
Do not enable the flags above in this session.

## Layout bench (scan server only)
AMAZON_SCAN_BENCH_ASINS=... AMAZON_SCAN_BENCH_LAYOUT=A|B|C|D \
  ./node_modules/.bin/ts-node --transpile-only scripts/amazon-scan-layout-bench.ts

Persistent profile = one Chromium context. Two browsers cannot share one profile directory.

## Rollback
Set the flags above back to false/unset. Local `listjetgo-amazon-public-worker-A` keeps claiming if AMAZON_PUBLIC_WORKER_OWNS_QUEUE=true and AMAZON_SCAN_REMOTE_WORKERS_ENABLED is not true. Do not start the login/auth worker.
