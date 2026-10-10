#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="1.0.15"
NAME="listjetgo-keepa-collector-${VER}"
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

copy keepa-collector.ts keepa-collector.ts
copy modules/keepaSensor/keepaCollectorLoop.ts modules/keepaSensor/keepaCollectorLoop.ts
copy modules/keepaSensor/keepaCollectorBootstrap.ts modules/keepaSensor/keepaCollectorBootstrap.ts
copy modules/keepaSensor/keepaCollectorLock.ts modules/keepaSensor/keepaCollectorLock.ts
copy modules/keepaSensor/keepaCollectorVersion.ts modules/keepaSensor/keepaCollectorVersion.ts
copy modules/keepaSensor/keepaCollectorReconcile.ts modules/keepaSensor/keepaCollectorReconcile.ts
copy modules/keepaSensor/keepaCollectorCovered.ts modules/keepaSensor/keepaCollectorCovered.ts
copy modules/keepaSensor/keepaTokenScheduler.ts modules/keepaSensor/keepaTokenScheduler.ts
copy modules/keepaSensor/keepaCollectorTelemetry.ts modules/keepaSensor/keepaCollectorTelemetry.ts
copy modules/keepaSensor/keepaCollectorEventSync.ts modules/keepaSensor/keepaCollectorEventSync.ts
copy modules/keepaSensor/keepaCollectorRepair.ts modules/keepaSensor/keepaCollectorRepair.ts
copy modules/keepaSensor/keepaCollectorAutoRepair.ts modules/keepaSensor/keepaCollectorAutoRepair.ts
copy modules/keepaSensor/keepaLocalDb.ts modules/keepaSensor/keepaLocalDb.ts
copy modules/keepaSensor/keepaMonitoredSnapshot.ts modules/keepaSensor/keepaMonitoredSnapshot.ts
copy modules/keepaSensor/keepaSnapshotDiff.ts modules/keepaSensor/keepaSnapshotDiff.ts
copy modules/keepaSensor/keepaEvidencePolicy.ts modules/keepaSensor/keepaEvidencePolicy.ts
copy modules/keepaSensor/keepaAsinProjection.ts modules/keepaSensor/keepaAsinProjection.ts
copy modules/keepaSensor/keepaDirectMutationGate.ts modules/keepaSensor/keepaDirectMutationGate.ts
copy modules/globalKeepa/keepaRadarParser.ts modules/globalKeepa/keepaRadarParser.ts
copy modules/globalKeepa/globalKeepaProductClient.ts modules/globalKeepa/globalKeepaProductClient.ts
copy modules/globalKeepa/globalKeepaTypes.ts modules/globalKeepa/globalKeepaTypes.ts
copy modules/keepa/keepaClient.ts modules/keepa/keepaClient.ts
copy modules/keepa/keepaTypes.ts modules/keepa/keepaTypes.ts
copy modules/keepa/keepaPriceTypes.ts modules/keepa/keepaPriceTypes.ts
copy modules/keepa/keepaPriceSelector.ts modules/keepa/keepaPriceSelector.ts
copy modules/amazonScan/amazonScanApplyPolicy.ts modules/amazonScan/amazonScanApplyPolicy.ts
copy amazon-scan-worker.ts amazon-scan-worker.ts
copy modules/amazonPublicWorker/amazonPublicWorker.ts modules/amazonPublicWorker/amazonPublicWorker.ts
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

cp -a "$ROOT/deploy/keepa-collector/README.md" "$DEST/README.md"
cp -a "$ROOT/deploy/keepa-collector/env.example" "$DEST/.env.example"
cp -a "$ROOT/deploy/keepa-collector/package.json" "$DEST/package.json"
cp -a "$ROOT/deploy/keepa-collector/package-lock.json" "$DEST/package-lock.json"
cp -a "$ROOT/deploy/keepa-collector/tsconfig.json" "$DEST/tsconfig.json"
if [[ -f "$ROOT/tsconfig.collector.json" ]]; then
  cp -a "$ROOT/tsconfig.collector.json" "$DEST/tsconfig.collector.json"
fi
if [[ -f "$ROOT/fixtures/keepaCollectorAutoRepair.fixtures.ts" ]]; then
  mkdir -p "$DEST/fixtures"
  cp -a "$ROOT/fixtures/keepaCollectorAutoRepair.fixtures.ts" "$DEST/fixtures/keepaCollectorAutoRepair.fixtures.ts"
fi
if [[ -f "$ROOT/fixtures/keepaCollectorDaemon.fixtures.ts" ]]; then
  mkdir -p "$DEST/fixtures"
  cp -a "$ROOT/fixtures/keepaCollectorDaemon.fixtures.ts" "$DEST/fixtures/keepaCollectorDaemon.fixtures.ts"
fi
if [[ -f "$ROOT/fixtures/keepaCollectorSelfRecovery.fixtures.ts" ]]; then
  mkdir -p "$DEST/fixtures"
  cp -a "$ROOT/fixtures/keepaCollectorSelfRecovery.fixtures.ts" "$DEST/fixtures/keepaCollectorSelfRecovery.fixtures.ts"
fi
mkdir -p "$DEST/systemd" "$DEST/scripts"
cp -a "$ROOT/deploy/keepa-collector/listjetgo-keepa-collector.service" "$DEST/systemd/listjetgo-keepa-collector.service"

if [[ ! -f "$DEST/modules/amazonBrowserWorker/amazonPageExtract.browser.js" ]]; then
  printf 'module.exports = function () { return { ok: false, errorCode: "NOT_USED_BY_KEEPA_COLLECTOR", error: "stub" }; }\n' \
    > "$DEST/modules/amazonBrowserWorker/amazonPageExtract.browser.js"
fi

(
  cd "$DEST"
  npm install --ignore-scripts --no-audit --no-fund --package-lock-only \
    >/tmp/keepa-collector-pack-npm.log 2>&1 || true
)

hits="$(grep -R -E --exclude-dir=node_modules \
    'BEGIN (OPENSSH|RSA|EC) PRIVATE KEY|DATABASE_URL=.+|KEEPA_API_KEY=.[^[:space:]]+|AMAZON_SCAN_WORKER_TOKEN=.+|EBAY_REFRESH_TOKEN=.+' \
    "$DEST" || true)"
hits="$(printf '%s\n' "$hits" | grep -v '.env.example' | grep -v 'KEEPA_API_KEY?.trim' | grep -v 'process.env.KEEPA_API_KEY' | grep -v '^$' || true)"
if [[ -n "$hits" ]]; then
  echo "$hits" >&2
  echo "Refusing to pack: secret-like content" >&2
  exit 1
fi
if [[ -e "$DEST/.env" || -d "$DEST/node_modules" ]]; then
  echo "Refusing to pack: .env or node_modules present" >&2
  exit 1
fi
if find "$DEST" -iname '*.log' -o -iname '*cookie*' -o -iname '*profile*' | grep -q .; then
  echo "Refusing to pack: log/cookie/profile path" >&2
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
tar -tzf "$TAR" | head -n 60 || true
rm -rf "$STAGE"
echo "PACKED $TAR"
