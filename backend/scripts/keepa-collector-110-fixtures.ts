import assert from "assert"
import {
  applySyncEvent,
  localReconcileManifest,
  openKeepaLocalDb,
  pendingObservationCount,
  setWorkerState,
  snapshotCount,
} from "../modules/keepaSensor/keepaLocalDb"
import { loadKeepaCollectorConfig, scanDueAsins } from "../modules/keepaSensor/keepaCollectorLoop"
import {
  KEEPA_BATCH_GAP_MS_DEFAULT,
  KEEPA_MIN_SLEEP_MS,
  KEEPA_SOLD_CADENCE_HOURS,
  KEEPA_STANDARD_CADENCE_HOURS,
  backlogDrainBatchSizes,
  formatKeepaDurationMs,
  keepaScanMode,
  nextDaemonSleepMs,
  tooEarlyToScan,
} from "../modules/keepaSensor/keepaTokenScheduler"
import { keepaCollectorDashboardFromRow } from "../modules/amazonScan/keepaCollectorDashboard"
import { KEEPA_CSV_INDEX } from "../modules/keepa/keepaPriceTypes"
import type { KeepaApiProduct } from "../modules/keepa/keepaTypes"
import { KEEPA_COLLECTOR_VERSION } from "../modules/keepaSensor/keepaCollectorVersion"

const HOUR = 3_600_000
const POLL = 300_000

function product(asin: string, current: number[]): KeepaApiProduct {
  return { asin, stats: { current } }
}

function csv(partial: { amazon?: number; fba?: number }): number[] {
  const cur = Array(40).fill(-1)
  if (partial.amazon != null) cur[KEEPA_CSV_INDEX.AMAZON] = partial.amazon
  if (partial.fba != null) cur[KEEPA_CSV_INDEX.COUNT_NEW_FBA] = partial.fba
  return cur
}

function envBase(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    KEEPA_COLLECTOR_ENABLED: "true",
    KEEPA_ENABLED: "true",
    KEEPA_COLLECTOR_RUN_MODE: "daemon",
    LISTJETGO_API_BASE: "http://local",
    KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
    KEEPA_API_KEY: "k",
    KEEPA_COLLECTOR_POLL_MS: String(POLL),
    KEEPA_COLLECTOR_BATCH_GAP_MS: "800",
    ...extra,
  }
}

function seedComplete(
  db: ReturnType<typeof openKeepaLocalDb>,
  rows: Array<{ asin: string; priority?: string; status?: string; nowMs?: number }>
) {
  for (const [i, row] of rows.entries()) {
    applySyncEvent(
      db,
      {
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
      },
      { remoteAckStatus: "ACKED_REMOTE" }
    )
  }
  setWorkerState(db, "bootstrap_status", "COMPLETE")
  setWorkerState(db, "bootstrap_phase", "COMPLETE")
  setWorkerState(db, "central_reconcile_hash", localReconcileManifest(db).hash)
  setWorkerState(db, "central_reconcile_count", String(localReconcileManifest(db).uniqueAsins))
}

function seedTokenSample(
  db: ReturnType<typeof openKeepaLocalDb>,
  input: { sampledAt: number; tokensLeft: number; refillRate: number; refillIn: number }
) {
  setWorkerState(db, "last_tokens_left", String(input.tokensLeft))
  setWorkerState(db, "last_refill_rate", String(input.refillRate))
  setWorkerState(db, "last_refill_in", String(input.refillIn))
  setWorkerState(db, "last_token_sampled_at", String(input.sampledAt))
  setWorkerState(db, "last_keepa_at", new Date(input.sampledAt).toISOString())
}

function keepaOk(asins: string[], tokensLeft: number, refillIn: number, refillRate: number, consumed: number) {
  return {
    ok: true as const,
    status: 200,
    durationMs: 5,
    body: {
      tokensLeft,
      refillRate,
      refillIn,
      tokensConsumed: consumed,
      tokenFlowReduction: 0,
      processingTimeInMs: 5,
      products: asins.map(a => product(a, csv({ amazon: 1000, fba: 1 }))),
    },
  }
}

async function main(): Promise<void> {
  assert.equal(KEEPA_COLLECTOR_VERSION, "1.0.14")
  assert.equal(KEEPA_SOLD_CADENCE_HOURS, 12)
  assert.equal(KEEPA_STANDARD_CADENCE_HOURS, 24)
  assert.equal(formatKeepaDurationMs(36903), "37 sn")
  assert.notEqual(formatKeepaDurationMs(36903), "36903s")
  assert.equal(keepaScanMode({ dueCount: 10, spendable: 900 }), "BACKLOG_DRAIN")
  assert.equal(keepaScanMode({ dueCount: 10, spendable: 0 }), "TOKEN_WAIT")
  assert.equal(keepaScanMode({ dueCount: 0, spendable: 900 }), "CADENCE_WAIT")

  const planned = backlogDrainBatchSizes({ dueCount: 915, tokensLeft: 920, reserve: 5, maxBatch: 100 })
  assert.deepEqual(planned, [100, 100, 100, 100, 100, 100, 100, 100, 100, 15])
  assert.equal(planned.reduce((a, b) => a + b, 0), 915)

  const drainSleep = nextDaemonSleepMs({
    skipped: null,
    waitMs: 0,
    keepaCalls: 1,
    pollMs: POLL,
    continueDrain: true,
    batchGapMs: 800,
  })
  assert.equal(drainSleep, 800)
  assert.ok(drainSleep !== POLL)
  const idleSleep = nextDaemonSleepMs({ skipped: "NO_DUE", waitMs: 0, keepaCalls: 0, pollMs: POLL })
  assert.ok(idleSleep <= 60_000)
  const busy = nextDaemonSleepMs({ skipped: null, waitMs: 0, keepaCalls: 1, pollMs: POLL, continueDrain: true, batchGapMs: 0 })
  assert.ok(busy >= KEEPA_MIN_SLEEP_MS)
  assert.ok(busy <= 5000)
  console.log("PASS planner 920/5/915 = 9x100+15, drain gap not poll")

  const now = Date.now()
  const cfg = loadKeepaCollectorConfig(envBase())
  assert.equal(cfg.batchGapMs, 800)
  const dbDrain = openKeepaLocalDb(":memory:")
  const drainAsins = Array.from({ length: 920 }, (_, i) => `B0${String(30000000 + i).slice(-8)}`)
  seedComplete(dbDrain, drainAsins.map(asin => ({ asin, nowMs: 1 })))
  seedTokenSample(dbDrain, { sampledAt: now, tokensLeft: 920, refillRate: 20, refillIn: 36903 })
  const sizes: number[] = []
  let tokens = 920
  let keepaCalls = 0
  for (let i = 0; i < 20; i++) {
    const r = await scanDueAsins(cfg, dbDrain, {
      nowMs: now + i,
      jitterMs: 0,
      keepaFetch: async input => {
        keepaCalls++
        sizes.push(input.asins.length)
        tokens -= input.asins.length
        return keepaOk(input.asins, tokens, 36903, 20, input.asins.length)
      },
    })
    if (r.keepaCalls > 0 && r.continueDrain) {
      const sleepFor = nextDaemonSleepMs({
        skipped: r.skipped,
        waitMs: r.waitMs,
        keepaCalls: r.keepaCalls,
        pollMs: cfg.pollMs,
        continueDrain: r.continueDrain,
        batchGapMs: cfg.batchGapMs,
      })
      assert.ok(sleepFor < 5_000)
      assert.ok(sleepFor !== cfg.pollMs)
    }
    if (!r.continueDrain) break
  }
  assert.deepEqual(sizes, [100, 100, 100, 100, 100, 100, 100, 100, 100, 15])
  assert.equal(keepaCalls, 10)
  assert.equal(tokens, 5)
  const waitAfterDrain = await scanDueAsins(cfg, dbDrain, {
    nowMs: now + 50,
    jitterMs: 0,
    keepaFetch: async () => {
      throw new Error("must-wait-reserve")
    },
  })
  assert.equal(waitAfterDrain.skipped, "TOKEN_WAIT")
  console.log("PASS live drain 100x9 + 15, reserve=5, no poll")

  const dbIdle = openKeepaLocalDb(":memory:")
  seedComplete(dbIdle, [{ asin: "B0NODUEAS1", nowMs: 1 }])
  dbIdle.prepare("UPDATE asin_registry SET last_scanned_at = ?, next_scan_at = ?").run(now, now + 24 * HOUR)
  seedTokenSample(dbIdle, { sampledAt: now, tokensLeft: 500, refillRate: 20, refillIn: 1000 })
  keepaCalls = 0
  const idle = await scanDueAsins(cfg, dbIdle, {
    nowMs: now,
    jitterMs: 0,
    keepaFetch: async () => {
      keepaCalls++
      throw new Error("must-not-call")
    },
  })
  assert.equal(keepaCalls, 0)
  assert.equal(idle.skipped, "NO_DUE")
  assert.ok(
    nextDaemonSleepMs({ skipped: idle.skipped, waitMs: idle.waitMs, keepaCalls: idle.keepaCalls, pollMs: POLL }) <= 60_000
  )
  console.log("PASS due=0 Keepa 0, idle wake ≤60s")

  const dbWait = openKeepaLocalDb(":memory:")
  seedComplete(dbWait, [{ asin: "B0WAITASI1", nowMs: 1 }])
  seedTokenSample(dbWait, { sampledAt: now, tokensLeft: 5, refillRate: 20, refillIn: 8000 })
  keepaCalls = 0
  const beforeRefill = await scanDueAsins(cfg, dbWait, {
    nowMs: now,
    jitterMs: 0,
    keepaFetch: async () => {
      keepaCalls++
      throw new Error("must-not-call")
    },
  })
  assert.equal(keepaCalls, 0)
  assert.equal(beforeRefill.skipped, "TOKEN_WAIT")
  assert.ok(beforeRefill.waitMs >= 8000)
  assert.ok(beforeRefill.waitMs < POLL)
  keepaCalls = 0
  const afterRefill = await scanDueAsins(cfg, dbWait, {
    nowMs: now + 12_000,
    jitterMs: 0,
    keepaFetch: async input => {
      keepaCalls++
      return keepaOk(input.asins, 5, 8000, 20, input.asins.length)
    },
  })
  assert.equal(keepaCalls, 1)
  assert.equal(afterRefill.keepaCalls, 1)
  console.log("PASS token=5 waits refillIn then rescan")

  const dbCadence = openKeepaLocalDb(":memory:")
  seedComplete(dbCadence, [
    { asin: "B0SOLD11H0", priority: "SOLD", nowMs: 1 },
    { asin: "B0STD23H00", priority: "STANDARD", nowMs: 1 },
  ])
  dbCadence.prepare("UPDATE asin_registry SET last_scanned_at = ?, next_scan_at = ? WHERE asin = 'B0SOLD11H0'").run(now - 11 * HOUR, now)
  dbCadence.prepare("UPDATE asin_registry SET last_scanned_at = ?, next_scan_at = ? WHERE asin = 'B0STD23H00'").run(now - 23 * HOUR, now)
  seedTokenSample(dbCadence, { sampledAt: now, tokensLeft: 100, refillRate: 20, refillIn: 1000 })
  keepaCalls = 0
  const early = await scanDueAsins(cfg, dbCadence, {
    nowMs: now,
    jitterMs: 0,
    keepaFetch: async () => {
      keepaCalls++
      throw new Error("must-not-scan-early")
    },
  })
  assert.equal(keepaCalls, 0)
  assert.equal(early.keepaCalls, 0)
  assert.equal(tooEarlyToScan({ priority: "SOLD", lastScannedAt: now - 11 * HOUR, nowMs: now }), true)
  assert.equal(tooEarlyToScan({ priority: "STANDARD", lastScannedAt: now - 23 * HOUR, nowMs: now }), true)
  dbCadence.prepare("UPDATE asin_registry SET last_scanned_at = ?, next_scan_at = ? WHERE asin = 'B0SOLD11H0'").run(now - 12 * HOUR, now)
  dbCadence.prepare("UPDATE asin_registry SET last_scanned_at = ?, next_scan_at = ? WHERE asin = 'B0STD23H00'").run(now - 24 * HOUR, now)
  const dueCadence = await scanDueAsins(cfg, dbCadence, {
    nowMs: now,
    jitterMs: 0,
    keepaFetch: async input => keepaOk(input.asins, 98, 1000, 20, input.asins.length),
  })
  assert.equal(dueCadence.keepaCalls, 1)
  assert.equal(dueCadence.requested, 2)
  console.log("PASS cadence 11h/23h skip, 12h/24h due")

  const dbPaused = openKeepaLocalDb(":memory:")
  seedComplete(dbPaused, [
    { asin: "B0PAUSEDAS1", status: "PAUSED", nowMs: 1 },
    { asin: "B0REMOVEDA1", status: "REMOVED", nowMs: 1 },
  ])
  seedTokenSample(dbPaused, { sampledAt: now, tokensLeft: 100, refillRate: 20, refillIn: 1000 })
  keepaCalls = 0
  const paused = await scanDueAsins(cfg, dbPaused, {
    nowMs: now,
    jitterMs: 0,
    keepaFetch: async () => {
      keepaCalls++
      throw new Error("must-not-scan-paused")
    },
  })
  assert.equal(keepaCalls, 0)
  assert.equal(paused.keepaCalls, 0)
  console.log("PASS PAUSED/REMOVED Keepa 0")

  const cfgOne = loadKeepaCollectorConfig(envBase({ KEEPA_COLLECTOR_BATCH_SIZE: "1" }))
  const dbObs = openKeepaLocalDb(":memory:")
  seedComplete(dbObs, [
    { asin: "B0OBS429A1", nowMs: 1 },
    { asin: "B0OBS429A2", nowMs: 1 },
  ])
  seedTokenSample(dbObs, { sampledAt: now, tokensLeft: 50, refillRate: 20, refillIn: 1000 })
  let keepaAsins: string[] = []
  const first = await scanDueAsins(cfgOne, dbObs, {
    nowMs: now + 2,
    jitterMs: 0,
    keepaFetch: async input => {
      keepaAsins.push(...input.asins)
      return keepaOk(input.asins, 49, 1000, 20, input.asins.length)
    },
    http: {
      getJson: async () => ({ status: 200, json: {} }),
      postJson: async () => ({ status: 429, json: { ok: false } }),
    },
  })
  assert.equal(first.keepaCalls, 1)
  assert.equal(snapshotCount(dbObs), 1)
  assert.equal(pendingObservationCount(dbObs), 1)
  assert.equal(first.continueDrain, true)
  const second = await scanDueAsins(cfgOne, dbObs, {
    nowMs: now + 3,
    jitterMs: 0,
    keepaFetch: async input => {
      keepaAsins.push(...input.asins)
      return keepaOk(input.asins, 48, 1000, 20, input.asins.length)
    },
    http: {
      getJson: async () => ({ status: 200, json: {} }),
      postJson: async () => ({ status: 429, json: { ok: false } }),
    },
  })
  assert.equal(second.keepaCalls, 1)
  assert.equal(snapshotCount(dbObs), 2)
  assert.equal(pendingObservationCount(dbObs), 2)
  assert.equal(new Set(keepaAsins).size, 2)
  keepaAsins = []
  const retry = await scanDueAsins(cfgOne, dbObs, {
    nowMs: now + 10_000,
    jitterMs: 0,
    keepaFetch: async input => {
      keepaAsins.push(...input.asins)
      throw new Error("must-not-requery-keepa")
    },
    http: {
      getJson: async () => ({ status: 200, json: {} }),
      postJson: async () => ({ status: 200, json: { ok: true } }),
    },
  })
  assert.equal(retry.keepaCalls, 0)
  assert.equal(keepaAsins.length, 0)
  assert.equal(pendingObservationCount(dbObs), 0)
  console.log("PASS observation 429 keeps snapshot/outbox, drain continues, retry without Keepa")

  const dbCost = openKeepaLocalDb(":memory:")
  seedComplete(dbCost, [{ asin: "B0COSTEXC1", nowMs: 1 }])
  seedTokenSample(dbCost, { sampledAt: now, tokensLeft: 20, refillRate: 20, refillIn: 1000 })
  const cost = await scanDueAsins(cfg, dbCost, {
    nowMs: now,
    jitterMs: 0,
    keepaFetch: async input => keepaOk(input.asins, 18, 1000, 20, 2),
  })
  assert.equal(cost.skipped, "TOKEN_COST_EXCEEDED")
  assert.equal(cost.stopKeepa, true)
  console.log("PASS cost>1 fail-closed")

  const dash = keepaCollectorDashboardFromRow({
    collectorId: "c1",
    hostname: "h1",
    collectedAt: new Date(now).toISOString(),
    nowMs: now,
    payload: {
      refillIn: 36903,
      tokensLeft: 920,
      refillRate: 20,
      dueSold: 521,
      dueStandard: 10053,
      spendableTokens: 915,
      scanMode: "BACKLOG_DRAIN",
      observationOutboxPending: 3,
      observationOutboxDelivered: 10,
      lastKeepaBatchSize: 100,
      estimatedBucketCapacity: 1200,
    },
  })
  assert.equal(dash.refillInLabel, "37 sn")
  assert.equal(dash.scanMode, "BACKLOG_DRAIN")
  assert.equal(dash.highTokensNotCritical, false)
  assert.match(String(dash.banner), /yüksek token bakiyesi normal değildir/i)
  const idleDash = keepaCollectorDashboardFromRow({
    collectorId: "c1",
    hostname: "h1",
    collectedAt: new Date(now).toISOString(),
    nowMs: now,
    payload: { refillIn: 36903, tokensLeft: 920, dueSold: 0, dueStandard: 0, refillRate: 20 },
  })
  assert.equal(idleDash.scanMode, "CADENCE_WAIT")
  assert.equal(idleDash.highTokensNotCritical, true)
  assert.match(String(idleDash.banner), /token birikmesi hata değildir/i)
  console.log("PASS panel refillIn 36903ms → 37 sn")

  assert.equal(KEEPA_BATCH_GAP_MS_DEFAULT, 800)
  console.log("PASS keepa-collector 1.0.14 fixtures")
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})
