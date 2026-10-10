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
  KEEPA_MIN_SLEEP_MS,
  KEEPA_SOLD_CADENCE_HOURS,
  KEEPA_STANDARD_CADENCE_HOURS,
  keepaProductQueryIsOneToken,
  nextDaemonSleepMs,
  nextScanAtMs,
  planKeepaBatch,
  projectKeepaTokenState,
  tokenCostExceeded,
  tokenWaitSleepMs,
  tooEarlyToScan,
} from "../modules/keepaSensor/keepaTokenScheduler"
import { buildGlobalKeepaProductUrl } from "../modules/globalKeepa/globalKeepaProductClient"
import { KEEPA_CSV_INDEX } from "../modules/keepa/keepaPriceTypes"
import type { KeepaApiProduct } from "../modules/keepa/keepaTypes"
import { KEEPA_COLLECTOR_VERSION } from "../modules/keepaSensor/keepaCollectorVersion"
import { observationPayloadHasForbiddenFields } from "../modules/keepaSensor/keepaEvidencePolicy"

const HOUR = 3_600_000

function product(asin: string, current: number[]): KeepaApiProduct {
  return { asin, stats: { current } }
}

function csv(partial: { amazon?: number; fba?: number }): number[] {
  const cur = Array(40).fill(-1)
  if (partial.amazon != null) cur[KEEPA_CSV_INDEX.AMAZON] = partial.amazon
  if (partial.fba != null) cur[KEEPA_CSV_INDEX.COUNT_NEW_FBA] = partial.fba
  return cur
}

function envBase(pollMs = HOUR): NodeJS.ProcessEnv {
  return {
    KEEPA_COLLECTOR_ENABLED: "true",
    KEEPA_ENABLED: "true",
    KEEPA_COLLECTOR_RUN_MODE: "daemon",
    LISTJETGO_API_BASE: "http://local",
    KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
    KEEPA_API_KEY: "k",
    KEEPA_COLLECTOR_POLL_MS: String(pollMs),
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
  assert.equal(KEEPA_COLLECTOR_VERSION, "1.0.9")
  assert.equal(KEEPA_SOLD_CADENCE_HOURS, 12)
  assert.equal(KEEPA_STANDARD_CADENCE_HOURS, 24)
  const url = new URL(buildGlobalKeepaProductUrl({ apiKey: "dummy-key", domain: 1, asins: ["B0TESTASIN"] }))
  assert.equal(keepaProductQueryIsOneToken(url.searchParams), true)
  assert.equal(tokenCostExceeded(1, 1), false)
  assert.equal(tokenCostExceeded(2, 1), true)
  const now = 2_000_000_000
  assert.equal(tooEarlyToScan({ priority: "SOLD", lastScannedAt: now, nowMs: now + 12 * HOUR - 1 }), true)
  assert.equal(tooEarlyToScan({ priority: "STANDARD", lastScannedAt: now, nowMs: now + 24 * HOUR - 1 }), true)
  assert.equal(nextScanAtMs(now, "SOLD") - now, 12 * HOUR)
  assert.equal(nextScanAtMs(now, "STANDARD") - now, 24 * HOUR)
  console.log("PASS cadence 12h/24h and 1-token query")

  const wake = planKeepaBatch({
    dueCount: 10,
    tokensLeft: 5,
    knownTelemetry: true,
    reserve: 5,
    refillInMs: 1000,
    pollMs: HOUR,
    jitterMs: 0,
  })
  assert.equal(wake.action, "wait_refill")
  if (wake.action === "wait_refill") {
    assert.ok(wake.waitMs >= 1000)
    assert.ok(wake.waitMs < 5_000)
    assert.ok(wake.waitMs < HOUR)
  }
  const sleep = nextDaemonSleepMs({
    skipped: "TOKEN_WAIT",
    waitMs: wake.action === "wait_refill" ? wake.waitMs : 0,
    keepaCalls: 0,
    pollMs: HOUR,
  })
  assert.ok(sleep < 5_000)
  assert.ok(sleep < HOUR)
  console.log("PASS due>0 token=5 refillIn=1000ms wakes near refill, not 1h")

  const cfg = loadKeepaCollectorConfig(envBase(HOUR))
  assert.equal(cfg.pollMs, HOUR)

  const dbStale = openKeepaLocalDb(":memory:")
  const staleAsins = Array.from({ length: 150 }, (_, i) => `B0${String(20000000 + i).slice(-8)}`)
  seedComplete(dbStale, staleAsins.map(asin => ({ asin, nowMs: 1 })))
  seedTokenSample(dbStale, { sampledAt: now - 10 * 60_000, tokensLeft: 5, refillRate: 20, refillIn: 1000 })
  const projected = projectKeepaTokenState({
    sampledAtMs: now - 10 * 60_000,
    nowMs: now,
    tokensLeft: 5,
    refillRate: 20,
    refillInMs: 1000,
  })
  assert.ok((projected.tokensLeft ?? 0) >= 105)
  assert.ok((projected.tokensLeft ?? 0) <= 20 * 60)
  let keepaCalls = 0
  const staleScan = await scanDueAsins(cfg, dbStale, {
    nowMs: now,
    jitterMs: 0,
    keepaFetch: async input => {
      keepaCalls++
      assert.ok(input.asins.length <= 100)
      assert.equal(input.asins.length, 100)
      return keepaOk(input.asins, 5, 1000, 20, input.asins.length)
    },
  })
  assert.equal(keepaCalls, 1)
  assert.equal(staleScan.keepaCalls, 1)
  assert.equal(staleScan.requested, 100)
  assert.ok(staleScan.requested <= 100)
  console.log("PASS stale 10min sample projects refill, batch<=100")

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
  assert.equal(idle.keepaCalls, 0)
  assert.equal(idle.skipped, "NO_DUE")
  console.log("PASS due=0 Keepa calls 0")

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
  assert.equal(beforeRefill.keepaCalls, 0)
  assert.equal(beforeRefill.skipped, "TOKEN_WAIT")
  assert.ok(beforeRefill.waitMs >= 1000)
  assert.ok(beforeRefill.waitMs < HOUR)
  console.log("PASS refill not elapsed → Keepa 0")

  const busy = tokenWaitSleepMs({ refillInMs: 0, pollMs: HOUR, jitterMs: 0 })
  assert.ok(busy >= KEEPA_MIN_SLEEP_MS)
  assert.ok(busy < 5_000)
  console.log("PASS busy-loop min sleep")

  const dbLoop = openKeepaLocalDb(":memory:")
  const loopAsins = ["B0LOOPAS01", "B0LOOPAS02", "B0LOOPAS03"]
  seedComplete(dbLoop, loopAsins.map(asin => ({ asin, nowMs: 1 })))
  seedTokenSample(dbLoop, { sampledAt: now, tokensLeft: 5, refillRate: 1, refillIn: 1000 })
  const sleeps: number[] = []
  let loopKeepa = 0
  for (let i = 0; i < 6; i++) {
    const t = now + i * 1000
    const r = await scanDueAsins(cfg, dbLoop, {
      nowMs: t,
      jitterMs: 0,
      keepaFetch: async input => {
        loopKeepa++
        assert.ok(input.asins.length <= 1)
        return keepaOk(input.asins, 5, 1000, 1, input.asins.length)
      },
    })
    const s = nextDaemonSleepMs({
      skipped: r.skipped,
      waitMs: r.waitMs,
      keepaCalls: r.keepaCalls,
      pollMs: HOUR,
    })
    sleeps.push(s)
    if (r.skipped === "TOKEN_WAIT" || r.keepaCalls > 0) {
      assert.ok(s < HOUR)
      assert.ok(s < 60_000)
    }
    if (r.keepaCalls > 0) assert.ok((r.requested ?? 0) <= 100)
  }
  assert.equal(loopKeepa, 3)
  assert.ok(sleeps.some(s => s > 0 && s < 5_000))
  console.log("PASS three refill loops rescan without long poll")

  const dbObs = openKeepaLocalDb(":memory:")
  seedComplete(dbObs, [{ asin: "B0OBSERV01", nowMs: 1 }])
  seedTokenSample(dbObs, { sampledAt: now, tokensLeft: 25, refillRate: 20, refillIn: 1000 })
  let posts = 0
  const delivered = await scanDueAsins(cfg, dbObs, {
    nowMs: now + 1,
    jitterMs: 0,
    keepaFetch: async input => keepaOk(input.asins, 24, 1000, 20, input.asins.length),
    http: {
      getJson: async () => ({ status: 200, json: {} }),
      postJson: async (_path, body) => {
        posts++
        assert.equal(observationPayloadHasForbiddenFields(body ?? {}), false)
        return { status: 200, json: { ok: true } }
      },
    },
  })
  assert.equal(delivered.keepaCalls, 1)
  assert.equal(delivered.scanned, 1)
  assert.equal(snapshotCount(dbObs), 1)
  assert.equal(posts, 1)
  assert.equal(pendingObservationCount(dbObs), 0)
  const nextAt = dbObs.prepare("SELECT next_scan_at, last_scanned_at FROM asin_registry WHERE asin = 'B0OBSERV01'").get() as {
    next_scan_at: number
    last_scanned_at: number
  }
  assert.equal(nextAt.next_scan_at - nextAt.last_scanned_at, 24 * HOUR)
  console.log("PASS successful scan observation outbox create+deliver")

  const dbRetry = openKeepaLocalDb(":memory:")
  seedComplete(dbRetry, [{ asin: "B0RETRYAS1", nowMs: 1 }])
  seedTokenSample(dbRetry, { sampledAt: now, tokensLeft: 25, refillRate: 20, refillIn: 1000 })
  keepaCalls = 0
  const fail = await scanDueAsins(cfg, dbRetry, {
    nowMs: now + 2,
    jitterMs: 0,
    keepaFetch: async input => {
      keepaCalls++
      return keepaOk(input.asins, 24, 1000, 20, input.asins.length)
    },
    http: {
      getJson: async () => ({ status: 500, json: {} }),
      postJson: async () => ({ status: 503, json: { ok: false } }),
    },
  })
  assert.equal(keepaCalls, 1)
  assert.equal(fail.keepaCalls, 1)
  assert.equal(pendingObservationCount(dbRetry), 1)
  dbRetry.prepare("UPDATE asin_registry SET last_scanned_at = ?, next_scan_at = ?").run(now + 2, now + 24 * HOUR)
  keepaCalls = 0
  const retry = await scanDueAsins(cfg, dbRetry, {
    nowMs: now + 3,
    jitterMs: 0,
    keepaFetch: async () => {
      keepaCalls++
      throw new Error("must-not-recall-keepa")
    },
    http: {
      getJson: async () => ({ status: 200, json: {} }),
      postJson: async () => ({ status: 200, json: { ok: true } }),
    },
  })
  assert.equal(keepaCalls, 0)
  assert.equal(retry.keepaCalls, 0)
  assert.equal(pendingObservationCount(dbRetry), 0)
  console.log("PASS API 5xx observation retry without Keepa")

  console.log("PASS keepa-collector 1.0.9 fixtures")
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})
