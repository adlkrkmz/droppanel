#!/usr/bin/env bash
# One PM2 process per slot. Example:
#   AMAZON_PUBLIC_WORKER_SLOT=A ./scripts/run-amazon-public-browser-worker.sh
#   ./scripts/run-amazon-public-browser-worker.sh B
set -euo pipefail
export LD_LIBRARY_PATH="/home/listjetgo/.local/pw-libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
export AMAZON_PUBLIC_WORKER_OWNS_QUEUE="${AMAZON_PUBLIC_WORKER_OWNS_QUEUE:-true}"
export AMAZON_LOGIN_WORKER_CLAIM_ENABLED="${AMAZON_LOGIN_WORKER_CLAIM_ENABLED:-false}"
export AMAZON_PUBLIC_WORKER_COUNT="${AMAZON_PUBLIC_WORKER_COUNT:-1}"
if [[ -n "${1:-}" ]]; then
  export AMAZON_PUBLIC_WORKER_SLOT="$(echo "$1" | tr '[:lower:]' '[:upper:]')"
fi
export AMAZON_PUBLIC_WORKER_SLOT="${AMAZON_PUBLIC_WORKER_SLOT:-A}"
cd /home/listjetgo/app/backend
exec ./node_modules/.bin/ts-node --transpile-only amazon-public-browser-worker.ts
