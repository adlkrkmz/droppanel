#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="1.0.2"
NAME="listjetgo-oxylabs-worker-${VER}"
STAGE="$(mktemp -d)"
DEST="${STAGE}/${NAME}"
OUT_DIR="${ROOT}/dist"
mkdir -p "$DEST" "$OUT_DIR"

cp -a "$ROOT/deploy/oxylabs-worker/oxylabs-verify-worker.mjs" "$DEST/oxylabs-verify-worker.mjs"
cp -a "$ROOT/deploy/oxylabs-worker/oxylabs-verify-ledger.mjs" "$DEST/oxylabs-verify-ledger.mjs"
cp -a "$ROOT/deploy/oxylabs-worker/package.json" "$DEST/package.json"
cp -a "$ROOT/deploy/oxylabs-worker/env.example" "$DEST/.env.example"
cp -a "$ROOT/deploy/oxylabs-worker/README.md" "$DEST/README.md"

if grep -R -E --exclude-dir=node_modules \
    'BEGIN (OPENSSH|RSA|EC) PRIVATE KEY|DATABASE_URL=.+|OXYLABS_VERIFY_WORKER_TOKEN=.+|OXYLABS_API_PASSWORD=.+|EBAY_REFRESH_TOKEN=.+' \
    "$DEST" | grep -v '.env.example' | grep -v '^$' >/tmp/oxylabs-pack-secrets.txt; then
  if [[ -s /tmp/oxylabs-pack-secrets.txt ]]; then
    cat /tmp/oxylabs-pack-secrets.txt >&2
    echo "Refusing to pack: secret-like content" >&2
    exit 1
  fi
fi
if [[ -e "$DEST/.env" || -d "$DEST/node_modules" ]]; then
  echo "Refusing to pack: .env or node_modules present" >&2
  exit 1
fi
if grep -R -n 'amazon_pricing' "$DEST" | grep -v 'forbidden' | grep -v 'OXYLABS_SOURCE' >/tmp/oxylabs-pack-pricing.txt; then
  if [[ -s /tmp/oxylabs-pack-pricing.txt ]] && grep -q 'source.*amazon_pricing' /tmp/oxylabs-pack-pricing.txt; then
    cat /tmp/oxylabs-pack-pricing.txt >&2
    echo "Refusing to pack: amazon_pricing call path" >&2
    exit 1
  fi
fi
if find "$DEST" \( -iname '*.log' -o -iname '*cookie*' -o -iname '*canary*.json' \) | grep -q .; then
  echo "Refusing to pack: log/cookie/canary json" >&2
  exit 1
fi

TAR="${OUT_DIR}/${NAME}.tar.gz"
tar -C "$STAGE" --owner=0 --group=0 --numeric-owner -czf "$TAR" "$NAME"
bad_paths="$(tar -tzf "$TAR" | awk '
  $0 ~ /^\// { print; next }
  $0 ~ /(^|\/)\.\.(\/|$)/ { print }
')"
if [[ -n "$bad_paths" ]]; then
  echo "$bad_paths" >&2
  echo "Refusing to pack: absolute or .. archive path" >&2
  exit 1
fi
sha256sum "$TAR" | tee "${TAR}.sha256"
tar -tzf "$TAR"
rm -rf "$STAGE"
echo "PACKED $TAR"
