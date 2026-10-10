#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="1.0.5"
NAME="amazon-scan-worker-${VER}"
STAGE="$(mktemp -d)"
DEST="${STAGE}/${NAME}"
OUT_DIR="${ROOT}/dist"
mkdir -p "$DEST" "$OUT_DIR"

copy() {
  local src="$1"
  local dst="$DEST/$2"
  mkdir -p "$(dirname "$dst")"
  cp -a "$ROOT/$src" "$dst"
}

copy amazon-scan-worker.ts amazon-scan-worker.ts
copy scripts/amazon-scan-layout-bench.ts scripts/amazon-scan-layout-bench.ts
copy scripts/verify-amazon-scan-worker.ts scripts/verify-amazon-scan-worker.ts
copy modules/amazonPublicWorker/amazonPublicWorker.ts modules/amazonPublicWorker/amazonPublicWorker.ts
copy modules/amazonPublicWorker/continueShoppingInterstitial.ts modules/amazonPublicWorker/continueShoppingInterstitial.ts
copy modules/amazonPublicWorker/amazonScanWorkerVersion.ts modules/amazonPublicWorker/amazonScanWorkerVersion.ts
copy modules/amazonPublicWorker/parsing.ts modules/amazonPublicWorker/parsing.ts
copy modules/amazonPublicWorker/persistence.ts modules/amazonPublicWorker/persistence.ts
copy modules/amazonPublicWorker/types.ts modules/amazonPublicWorker/types.ts
copy modules/amazonPublicWorker/amazonPublicWorkerPool.ts modules/amazonPublicWorker/amazonPublicWorkerPool.ts
copy modules/amazonPublicWorker/alternateOfferSelect.ts modules/amazonPublicWorker/alternateOfferSelect.ts
copy modules/amazonPublicWorker/mapPublicObservationToVerificationPayload.ts modules/amazonPublicWorker/mapPublicObservationToVerificationPayload.ts
copy modules/amazonScan/amazonScanHostTelemetry.ts modules/amazonScan/amazonScanHostTelemetry.ts
copy modules/amazonBrowserWorker/amazonBrowserWorkerConstants.ts modules/amazonBrowserWorker/amazonBrowserWorkerConstants.ts
copy modules/amazonBrowserWorker/amazonOfferPrimeFbaGate.ts modules/amazonBrowserWorker/amazonOfferPrimeFbaGate.ts
copy modules/amazonBrowserWorker/amazonPageExtract.ts modules/amazonBrowserWorker/amazonPageExtract.ts
copy modules/amazonVerification/amazonVerificationNormalize.ts modules/amazonVerification/amazonVerificationNormalize.ts
copy modules/amazonVerification/amazonVerificationTypes.ts modules/amazonVerification/amazonVerificationTypes.ts

cp -a "$ROOT/deploy/amazon-scan-remote/README.md" "$DEST/README.md"
cp -a "$ROOT/deploy/amazon-scan-remote/env.example" "$DEST/.env.example"
cp -a "$ROOT/deploy/amazon-scan-remote/package.json" "$DEST/package.json"
cp -a "$ROOT/deploy/amazon-scan-remote/tsconfig.json" "$DEST/tsconfig.json"
mkdir -p "$DEST/systemd" "$DEST/scripts"
cp -a "$ROOT/deploy/amazon-scan-remote/listjetgo-amazon-scan@.service" "$DEST/systemd/listjetgo-amazon-scan@.service"
cp -a "$ROOT/deploy/amazon-scan-remote/run-amazon-scan-worker.sh" "$DEST/scripts/run-amazon-scan-worker.sh"
chmod +x "$DEST/scripts/run-amazon-scan-worker.sh"

# amazonPageExtract.ts reads sibling JS at load; keep a stub so an accidental value-import does not crash packaging checks.
if [[ ! -f "$DEST/modules/amazonBrowserWorker/amazonPageExtract.browser.js" ]]; then
  printf 'module.exports = function () { return { ok: false, errorCode: "NOT_USED_BY_PUBLIC_SCAN", error: "stub" }; }\n' \
    > "$DEST/modules/amazonBrowserWorker/amazonPageExtract.browser.js"
fi

(
  cd "$DEST"
  npm install --ignore-scripts --no-audit --no-fund
    >/tmp/amazon-scan-pack-npm.log 2>&1
  rm -rf node_modules
)

hits="$(grep -R -E --exclude-dir=node_modules \
    'BEGIN (OPENSSH|RSA|EC) PRIVATE KEY|DATABASE_URL=.+|AMAZON_SCAN_WORKER_TOKEN=.+|EBAY_REFRESH_TOKEN=.+' \
    "$DEST" || true)"
hits="$(printf '%s\n' "$hits" | grep -v '.env.example' | grep -v 'delete process.env' | grep -v 'AMAZON_SCAN_WORKER_TOKEN (>=32)' | grep -v 'required env' | grep -v '^$' || true)"
if [[ -n "$hits" ]]; then
  echo "$hits" >&2
  echo "Refusing to pack: secret-like content" >&2
  exit 1
fi
if [[ -e "$DEST/.env" || -d "$DEST/node_modules" || -d "$DEST/var" ]]; then
  echo "Refusing to pack: .env, node_modules, or var present" >&2
  exit 1
fi

TAR="${OUT_DIR}/${NAME}.tar.gz"
tar -C "$STAGE" --owner=0 --group=0 --numeric-owner -czf "$TAR" "$NAME"
sha256sum "$TAR" | tee "${TAR}.sha256"
# list contents for the operator
tar -tzf "$TAR" | head -n 80
rm -rf "$STAGE"
echo "PACKED $TAR"
