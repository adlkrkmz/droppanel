#!/usr/bin/env bash
set -euo pipefail
export LD_LIBRARY_PATH="/home/listjetgo/.local/pw-libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
cd /home/listjetgo/app/backend
exec ./node_modules/.bin/ts-node --transpile-only scripts/amazon-public-worker-readonly-20.ts
