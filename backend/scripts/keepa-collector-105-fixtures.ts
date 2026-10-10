import assert from "assert"
import { buildGlobalKeepaProductUrl } from "../modules/globalKeepa/globalKeepaProductClient"
import { keepaCollectorDashboardFromRow } from "../modules/amazonScan/keepaCollectorDashboard"
import { keepaDirectMutationsEnabled } from "../modules/keepaSensor/keepaDirectMutationGate"
import {
  applySyncEvent,
  candidateCount,
  dueAsins,
  keepaScanAllowed,
  localReconcileManifest,
  openKeepaLocalDb,
  saveSnapshot,
  setWorkerState,
  snapshotCount,
} from "../modules/keepaSensor/keepaLocalDb"
import {
  loadKeepaCollectorConfig,
  runKeepaCollector,
  scanDueAsins,
  buildCollectorTelemetryPayload,
} from "../modules/keepaSensor/keepaCollectorLoop"
import {
  keepaCapacityStats,
  keepaProductQueryIsOneToken,
  planKeepaBatch,
  tokenCostExceeded,
} from "../modules/keepaSensor/keepaTokenScheduler"
import { sanitizeKeepaCollectorTelemetry, telemetryContainsForbidden } from "../modules/keepaSensor/keepaCollectorTelemetry"
import { KEEPA_CSV_INDEX } from "../modules/keepa/keepaPriceTypes"
import type { KeepaApiProduct } from "../modules/keepa/keepaTypes"
import { KEEPA_COLLECTOR_VERSION } from "../modules/keepaSensor/keepaCollectorVersion"
import { extractKeepaMonitoredSnapshot, monitoredSnapshotFingerprint } from "../modules/keepaSensor/keepaMonitoredSnapshot"

function product(asin: string, current: number[]): KeepaApiProduct {
  return { asin, stats: { current } }
}

function csv(partial: { amazon?: number; neu?: number; buyBox?: number; fba?: number; fbm?: number }): number[] {
  const cur = Array(40).fill(-1)
  if (partial.amazon != null) cur[KEEPA_CSV_INDEX.AMAZON] = partial.amazon
  if (partial.neu != null) cur[KEEPA_CSV_INDEX.NEW] = partial.neu
  if (partial.buyBox != null) cur[KEEPA_CSV_INDEX.BUY_BOX_SHIPPING] = partial.buyBox
  if (partial.fba != null) cur[KEEPA_CSV_INDEX.COUNT_NEW_FBA] = partial.fba
  if (partial.fbm != null) cur[KEEPA_CSV_INDEX.COUNT_NEW_FBM] = partial.fbm
  return cur
}

function envBase(): NodeJS.ProcessEnv {
  return {
    KEEPA_COLLECTOR_ENABLED: "true",
    KEEPA_ENABLED: "true",
    KEEPA_COLLECTOR_RUN_MODE: "once",
    LISTJETGO_API_BASE: "http://local",
    KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
    KEEPA_API_KEY: "k",
  }
}

function seedComplete(db: ReturnType<typeof openKeepaLocalDb>, rows: Array<{ asin: string; priority?: string; status?: string; nowMs?: number }>) {
  for (const [i, row] of rows.entries()) {
    applySyncEvent(db, {
      eventId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      asin: row.asin,
      eventType: "ASIN_UPSERT",
      sourceVersion: 1,
      payload: {
        status: row.status ?? "ACTIVE",
        activeConsumerCount: (row.status ?? "ACTIVE") === "ACTIVE" ? 1 : 0,
        priority: row.priority ?? "STANDARD",
        cadenceHours: row.priority === "SOLD" ? 12 : 24,
      },
      nowMs: row.nowMs ?? 1_000_000,
    }, { remoteAckStatus: "ACKED_REMOTE" })
  }
  setWorkerState(db, "bootstrap_status", "COMPLETE")
  setWorkerState(db, "bootstrap_phase", "COMPLETE")
  setWorkerState(db, "central_reconcile_hash", localReconcileManifest(db).hash)
  setWorkerState(db, "central_reconcile_count", String(localReconcileManifest(db).uniqueAsins))
}

async function main(): Promise<void> {
  assert.equal(KEEPA_COLLECTOR_VERSION, "1.0.8")

  const cap = keepaCapacityStats({ sold: 574, standard: 12021, refillRate: 20 })
  assert.equal(cap.estimatedBucketCapacity, 1200)
  assert.equal(cap.requiredDaily, 13169)
  assert.equal(cap.dailyCapacity, 28800)
  assert.ok(Math.abs(cap.utilizationPct - 45.7) < 0.1)
  console.log("PASS 1+16 capacity 20/dk bucket 1200 required 13169 util ~45.7%")

  const p100 = planKeepaBatch({ dueCount: 500, tokensLeft: 1195, knownTelemetry: true, reserve: 5 })
  assert.equal(p100.action, "call")
  if (p100.action === "call") assert.equal(p100.batch, 100)
  console.log("PASS 2 tokensLeft=1195 due=500 batch=100")

  const p1 = planKeepaBatch({ dueCount: 50, tokensLeft: 6, knownTelemetry: true, reserve: 5 })
  assert.equal(p1.action, "call")
  if (p1.action === "call") {
    assert.equal(p1.batch, 1)
    assert.equal(p1.probe, false)
  }
  console.log("PASS 3 tokensLeft=6 reserve=5 batch=1 no fill wait")

  const pWait = planKeepaBatch({ dueCount: 10, tokensLeft: 5, knownTelemetry: true, reserve: 5, refillInSec: 8, jitterMs: 0 })
  assert.equal(pWait.action, "wait_refill")
  console.log("PASS 4 tokensLeft=5 no Keepa call")

  const pIdle = planKeepaBatch({ dueCount: 0, tokensLeft: 1200, knownTelemetry: true, reserve: 5 })
  assert.equal(pIdle.action, "idle")
  console.log("PASS 5 due=0 no call")

  const url = new URL(buildGlobalKeepaProductUrl({ apiKey: "dummy-key", domain: 1, asins: ["B0TESTASIN"] }))
  assert.equal(keepaProductQueryIsOneToken(url.searchParams), true)
  assert.equal(url.searchParams.get("history"), "0")
  assert.equal(url.searchParams.get("stats"), "1")
  assert.equal(url.searchParams.has("offers"), false)
  assert.equal(url.searchParams.has("update"), false)
  console.log("PASS 9 product URL 1-token history=0 stats=1 no offers")

  assert.equal(tokenCostExceeded(1, 1), false)
  assert.equal(tokenCostExceeded(2, 1), true)
  console.log("PASS 10 tokensConsumed>requested fail-closed")

  const now = 10_000_000_000
  const dbCadence = openKeepaLocalDb(":memory:")
  seedComplete(dbCadence, [
    { asin: "B0SOLDEARLY", priority: "SOLD", nowMs: now },
    { asin: "B0STDEARLY1", priority: "STANDARD", nowMs: now },
    { asin: "B0PAUSE0001", status: "PAUSED_QTY_ZERO", nowMs: now },
    { asin: "B0REMOVE001", status: "REMOVED", nowMs: now },
  ])
  dbCadence.prepare("UPDATE asin_registry SET last_scanned_at = ?, next_scan_at = ? WHERE asin = 'B0SOLDEARLY'").run(now - 11 * 3600_000, now)
  dbCadence.prepare("UPDATE asin_registry SET last_scanned_at = ?, next_scan_at = ? WHERE asin = 'B0STDEARLY1'").run(now - 23 * 3600_000, now)
  const early = dueAsins(dbCadence, now, 50)
  assert.equal(early.some(r => r.asin === "B0SOLDEARLY"), false)
  assert.equal(early.some(r => r.asin === "B0STDEARLY1"), false)
  assert.equal(early.some(r => r.status === "PAUSED_QTY_ZERO"), false)
  assert.equal(early.some(r => r.status === "REMOVED"), false)
  dbCadence.prepare("UPDATE asin_registry SET last_scanned_at = ?, next_scan_at = ? WHERE asin = 'B0SOLDEARLY'").run(now - 12 * 3600_000, now)
  dbCadence.prepare("UPDATE asin_registry SET last_scanned_at = ?, next_scan_at = ? WHERE asin = 'B0STDEARLY1'").run(now - 24 * 3600_000, now)
  const onTime = dueAsins(dbCadence, now, 50)
  assert.equal(onTime.some(r => r.asin === "B0SOLDEARLY"), true)
  assert.equal(onTime.some(r => r.asin === "B0STDEARLY1"), true)
  console.log("PASS 6-8 SOLD<12h STANDARD<24h PAUSED/REMOVED excluded")

  const cfg = loadKeepaCollectorConfig(envBase())
  const dbScan = openKeepaLocalDb(":memory:")
  seedComplete(dbScan, [{ asin: "B0KEEPAS01", nowMs: 1 }])
  const okBody = {
    ok: true as const,
    status: 200,
    durationMs: 5,
    body: {
      tokensLeft: 100,
      refillRate: 20,
      refillIn: 1,
      tokensConsumed: 1,
      tokenFlowReduction: 0,
      processingTimeInMs: 5,
      products: [product("B0KEEPAS01", csv({ amazon: 1000, buyBox: 1000, fba: 2 }))],
    },
  }
  const first = await scanDueAsins(cfg, dbScan, { keepaFetch: async () => okBody, nowMs: 2, jitterMs: 0 })
  assert.equal(first.keepaCalls, 1)
  assert.equal(first.candidates, 0)
  assert.equal(snapshotCount(dbScan), 1)
  console.log("PASS 13 first baseline candidate 0")

  const second = await scanDueAsins(cfg, dbScan, { keepaFetch: async () => okBody, nowMs: 3, jitterMs: 0 })
  assert.equal(second.skipped === "NO_DUE" || second.scanned === 0, true)
  dbScan.prepare("UPDATE asin_registry SET last_scanned_at = 0, next_scan_at = 0 WHERE asin = 'B0KEEPAS01'").run()
  const same = await scanDueAsins(cfg, dbScan, { keepaFetch: async () => okBody, nowMs: 4, jitterMs: 0 })
  assert.equal(same.candidates, 0)
  console.log("PASS 14 same snapshot no new candidate")

  dbScan.prepare("UPDATE asin_registry SET last_scanned_at = 0, next_scan_at = 0 WHERE asin = 'B0KEEPAS01'").run()
  const changed = await scanDueAsins(cfg, dbScan, {
    nowMs: 5,
    jitterMs: 0,
    keepaFetch: async () => ({
      ...okBody,
      body: {
        ...okBody.body,
        tokensConsumed: 1,
        products: [product("B0KEEPAS01", csv({ amazon: 1100, buyBox: 1100, fba: 2 }))],
      },
    }),
  })
  assert.equal(changed.candidates, 0)
  assert.equal(candidateCount(dbScan), 0)
  assert.equal(snapshotCount(dbScan), 1)
  console.log("PASS 15 snapshot field diff, no local candidate (trusted-evidence is central)")

  const dbCost = openKeepaLocalDb(":memory:")
  seedComplete(dbCost, [{ asin: "B0TOKENCOST", nowMs: 1 }])
  const cost = await scanDueAsins(cfg, dbCost, {
    nowMs: 2,
    jitterMs: 0,
    keepaFetch: async () => ({
      ...okBody,
      body: { ...okBody.body, tokensConsumed: 2, products: [product("B0TOKENCOST", csv({ amazon: 1000, fba: 1 }))] },
    }),
  })
  assert.equal(cost.skipped, "TOKEN_COST_EXCEEDED")
  assert.equal(cost.stopKeepa, true)
  assert.equal(snapshotCount(dbCost), 0)
  const cost2 = await scanDueAsins(cfg, dbCost, { nowMs: 3, keepaFetch: async () => { throw new Error("must-not-call") } })
  assert.equal(cost2.keepaCalls, 0)
  console.log("PASS 10b TOKEN_COST_EXCEEDED no snapshot, no next Keepa")

  const db429 = openKeepaLocalDb(":memory:")
  seedComplete(db429, [{ asin: "B0HTTP42901", nowMs: 1 }])
  saveSnapshot(db429, "B0HTTP42901", "fp", "{}", 1)
  const r429 = await scanDueAsins(cfg, db429, {
    nowMs: 2,
    jitterMs: 0,
    keepaFetch: async () => ({ ok: false, status: 429, code: "HTTP_429", body: { refillIn: 2, products: [] }, message: "429", durationMs: 1 }),
  })
  assert.equal(r429.skipped, "HTTP_429")
  assert.ok(r429.waitMs >= 2000)
  assert.equal(snapshotCount(db429), 1)
  console.log("PASS 11 429 wait refillIn, snapshot kept")

  const db401 = openKeepaLocalDb(":memory:")
  seedComplete(db401, [{ asin: "B0HTTP40101", nowMs: 1 }])
  const r401 = await scanDueAsins(cfg, db401, {
    nowMs: 2,
    keepaFetch: async () => ({ ok: false, status: 401, code: "HTTP_401", body: null, message: "401", durationMs: 1 }),
  })
  assert.equal(r401.stopKeepa, true)
  const r401b = await scanDueAsins(cfg, db401, { nowMs: 3, keepaFetch: async () => { throw new Error("no") } })
  assert.equal(r401b.keepaCalls, 0)
  console.log("PASS 11 401 fail-closed")

  const db403 = openKeepaLocalDb(":memory:")
  seedComplete(db403, [{ asin: "B0HTTP40301", nowMs: 1 }])
  const r403 = await scanDueAsins(cfg, db403, {
    nowMs: 2,
    keepaFetch: async () => ({ ok: false, status: 403, code: "HTTP_403", body: null, message: "403", durationMs: 1 }),
  })
  assert.equal(r403.stopKeepa, true)
  console.log("PASS 11 403 fail-closed")

  const db5 = openKeepaLocalDb(":memory:")
  seedComplete(db5, [{ asin: "B0HTTP5XX01", nowMs: 1 }])
  const r5 = await scanDueAsins(cfg, db5, {
    nowMs: 2,
    keepaFetch: async () => ({ ok: false, status: 502, code: "HTTP_5XX", body: null, message: "502", durationMs: 1 }),
  })
  assert.equal(r5.skipped, "HTTP_5XX")
  assert.ok(r5.waitMs > 0)
  assert.equal(snapshotCount(db5), 0)
  console.log("PASS 11 5xx backoff, no fake snapshot")

  const dbErr = openKeepaLocalDb(":memory:")
  seedComplete(dbErr, [{ asin: "B0PARSEERR1", nowMs: 1 }])
  const nextBefore = dbErr.prepare("SELECT next_scan_at AS n FROM asin_registry WHERE asin='B0PARSEERR1'").get() as { n: number }
  await scanDueAsins(cfg, dbErr, {
    nowMs: 2,
    keepaFetch: async () => ({ ok: true, status: 200, durationMs: 1, body: { tokensConsumed: 1, tokensLeft: 10, products: [] } }),
  })
  const nextAfter = dbErr.prepare("SELECT next_scan_at AS n FROM asin_registry WHERE asin='B0PARSEERR1'").get() as { n: number }
  assert.equal(nextAfter.n, nextBefore.n)
  assert.equal(snapshotCount(dbErr), 0)
  assert.equal(candidateCount(dbErr), 0)
  console.log("PASS 12 parse/empty products no cadence/snapshot/candidate")

  const dirty = sanitizeKeepaCollectorTelemetry({
    collectorVersion: "1.0.5",
    collectorId: "scraper-1",
    asin: "B0SECRETS01",
    keepaApiKey: "abc",
    tokensLeft: 9,
  } as Record<string, unknown>)
  assert.equal("asin" in dirty, false)
  assert.equal("keepaApiKey" in dirty, false)
  assert.equal(dirty.tokensLeft, 9)
  assert.equal(telemetryContainsForbidden({ asin: "B0SECRETS01" }), true)
  const dbTel = openKeepaLocalDb(":memory:")
  seedComplete(dbTel, [{ asin: "B0TELEM0001", nowMs: 1 }])
  const payload = buildCollectorTelemetryPayload(cfg, dbTel)
  assert.equal(telemetryContainsForbidden(payload), false)
  assert.equal(JSON.stringify(payload).includes("B0TELEM0001"), false)
  console.log("PASS 17 telemetry whitelist no ASIN/secret")

  const stale = keepaCollectorDashboardFromRow({
    collectorId: "scraper-1",
    hostname: "scraper",
    payload: { collectorVersion: "1.0.5", tokensLeft: 1100 },
    collectedAt: new Date(Date.now() - 120_000).toISOString(),
  })
  assert.equal(stale.status, "OFFLINE")
  const fresh = keepaCollectorDashboardFromRow({
    collectorId: "scraper-1",
    hostname: "scraper",
    payload: { collectorVersion: "1.0.5", tokensLeft: 1100, dueSold: 0, dueStandard: 0 },
    collectedAt: new Date().toISOString(),
  })
  assert.equal(fresh.status, "ONLINE")
  console.log("PASS 18 stale heartbeat OFFLINE")

  const bootOnly = await runKeepaCollector({
    env: {
      KEEPA_COLLECTOR_ENABLED: "true",
      KEEPA_COLLECTOR_RUN_MODE: "bootstrap-only",
      LISTJETGO_API_BASE: "http://local",
      KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
      KEEPA_ENABLED: "true",
      KEEPA_API_KEY: "dummy-keepa-key-xx",
      KEEPA_LOCAL_DB_PATH: "/tmp/kc-105-boot.sqlite",
    },
    skipLock: true,
    keepaFetch: async () => {
      throw new Error("keepa-must-not-run")
    },
    http: {
      getJson: async () => ({ status: 500, json: {} }),
      postJson: async () => ({ status: 500, json: {} }),
    },
  })
  assert.equal(bootOnly.keepaCalls, 0)
  console.log("PASS 19 bootstrap-only Keepa 0")

  assert.equal(keepaDirectMutationsEnabled(), false)
  assert.equal(keepaScanAllowed(dbScan).allowed, true)
  console.log("PASS 20 direct mutation gate false, ebay invocation 0 (no live call)")

  const fp1 = monitoredSnapshotFingerprint(extractKeepaMonitoredSnapshot(product("B0KEEPAS01", csv({ amazon: 1000, buyBox: 1000, fba: 2 })))!)
  const fp2 = monitoredSnapshotFingerprint(extractKeepaMonitoredSnapshot(product("B0KEEPAS01", csv({ amazon: 1000, buyBox: 1000, fba: 2 })))!)
  assert.equal(fp1, fp2)
  console.log("PASS keepa-collector 1.0.5 fixtures (compat 1.0.6)")
}

void main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .then(() => process.exit(0))
