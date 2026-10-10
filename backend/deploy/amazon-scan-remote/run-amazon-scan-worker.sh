#!/usr/bin/env bash
# Remote unauthenticated Amazon scan worker. No DATABASE_URL / eBay secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
unset DATABASE_URL || true
if [[ -n "${1:-}" ]]; then
  export AMAZON_PUBLIC_WORKER_SLOT="$(echo "$1" | tr '[:lower:]' '[:upper:]')"
fi
export AMAZON_PUBLIC_WORKER_SLOT="${AMAZON_PUBLIC_WORKER_SLOT:-A}"
export AMAZON_SCAN_WORKER_ROLE="${AMAZON_SCAN_WORKER_ROLE:-ROUTINE}"
exec ./node_modules/.bin/ts-node --transpile-only amazon-scan-worker.ts
