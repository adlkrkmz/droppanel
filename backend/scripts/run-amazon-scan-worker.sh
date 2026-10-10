#!/usr/bin/env bash
# Remote unauthenticated Amazon scan worker. No DATABASE_URL / eBay secrets.
set -euo pipefail
export LD_LIBRARY_PATH="/home/listjetgo/.local/pw-libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
if [[ -n "${1:-}" ]]; then
  export AMAZON_PUBLIC_WORKER_SLOT="$(echo "$1" | tr '[:lower:]' '[:upper:]')"
fi
export AMAZON_PUBLIC_WORKER_SLOT="${AMAZON_PUBLIC_WORKER_SLOT:-A}"
export AMAZON_SCAN_WORKER_ROLE="${AMAZON_SCAN_WORKER_ROLE:-ROUTINE}"
cd /home/listjetgo/app/backend
exec ./node_modules/.bin/ts-node --transpile-only amazon-scan-worker.ts
