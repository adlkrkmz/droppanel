#!/usr/bin/env bash
export LD_LIBRARY_PATH="/home/listjetgo/.local/pw-libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
export AMAZON_LOGIN_WORKER_CLAIM_ENABLED="${AMAZON_LOGIN_WORKER_CLAIM_ENABLED:-false}"
export AMAZON_AUTH_WORKER_DISABLED="${AMAZON_AUTH_WORKER_DISABLED:-true}"
cd /home/listjetgo/app/backend
exec ./node_modules/.bin/ts-node --transpile-only amazon-browser-worker.ts
