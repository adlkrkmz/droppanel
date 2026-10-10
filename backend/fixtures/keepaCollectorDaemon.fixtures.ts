import fs from "fs"
import os from "os"
import path from "path"
import { computeKeepaReconcileManifest } from "../modules/keepaSensor/keepaCollectorReconcile"
import {
  applySyncEvent,
  countDueAsins,
  dueAsins,
  enqueueObservationOutbox,
  localReconcileManifest,
  nextDueAtMs,
  openKeepaLocalDb,
  setBootstrapPhase,
  setWorkerState,
} from "../modules/keepaSensor/keepaLocalDb"
import { loadKeepaCollectorConfig, scanDueAsins } from "../modules/keepaSensor/keepaCollectorLoop"
import {
  createAutoRepairState,
  KEEPA_AUTO_REPAIR_BACKOFF_MS,
  reconcileThenMaybeAutoRepair,
} from "../modules/keepaSensor/keepaCollectorAutoRepair"
import {
  dueWorkStallAdvance,
  keepaScanMode,
  KEEPA_MAX_IDLE_SLEEP_MS,
  KEEPA_STALL_MIN_WALL_MS,
  nextDaemonSleepMs,
  planKeepaBatch,
  projectKeepaTokenState,
  spendableTokens,
} from "../modules/keepaSensor/keepaTokenScheduler"
import type { CollectorHttp } from "../modules/keepaSensor/keepaCollectorBootstrap"

let failed = 0
function check(name: string, cond: unknown, detail?: unknown): void {
  if (cond) console.log(`PASS ${name}`)
  else {
    failed++
    console.error(`FAIL ${name}`, detail ?? "")
  }
}

function asin(n: number): string {
  return `B${String(n).padStart(9, "0")}`
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "keepa-dm-"))
}

function openDb(dir: string) {
  const dbPath = path.join(dir, "keepa-worker.sqlite")
  const db = openKeepaLocalDb(dbPath)
  setBootstrapPhase(db, "COMPLETE")
  return { db, dbPath }
}

function markReconciled(db: ReturnType<typeof openKeepaLocalDb>): ReturnType<typeof localReconcileManifest> {
  const man = localReconcileManifest(db)
  setWorkerState(db, "central_reconcile_hash", man.hash)
  setWorkerState(db, "central_reconcile_count", String(man.uniqueAsins))
  return man
}

function cfgFor(dbPath: string) {
  return loadKeepaCollectorConfig({
    LISTJETGO_API_BASE: "http://127.0.0.1",
    KEEPA_COLLECTOR_WORKER_TOKEN: "T".repeat(32),
    KEEPA_API_KEY: "K".repeat(20),
    KEEPA_LOCAL_DB_PATH: dbPath,
    KEEPA_COLLECTOR_ENABLED: "true",
    KEEPA_COLLECTOR_RUN_MODE: "daemon",
    KEEPA_ENABLED: "true",
    KEEPA_TOKEN_RESERVE: "100",
    KEEPA_COLLECTOR_POLL_MS: "15000",
    KEEPA_COLLECTOR_BATCH_SIZE: "100",
    KEEPA_COLLECTOR_MAX_BATCHES: "1",
  })
}

function insertAsin(
  db: ReturnType<typeof openKeepaLocalDb>,
  row: {
    asin: string
    status?: string
    priority?: string
    cadence?: number
    consumers?: number
    nextScan?: number
    lastScanned?: number | null
    nowMs?: number
  }
): void {
  const nowMs = row.nowMs ?? Date.now()
  db.prepare(
    `INSERT INTO asin_registry (
       asin, active_consumer_count, status, priority, cadence_hours, next_scan_at,
       source_version, queue_seq, created_at, updated_at, last_scanned_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`
  ).run(
    row.asin,
    row.consumers ?? 1,
    row.status ?? "ACTIVE",
    row.priority ?? "STANDARD",
    row.cadence ?? (row.priority === "SOLD" ? 12 : 24),
    row.nextScan ?? nowMs + 365 * 24 * 3600_000,
    nowMs,
    nowMs,
    row.lastScanned === undefined ? null : row.lastScanned
  )
}

function mockHttp(opts: {
  central: { hash: string; uniqueAsins: number; active: number; pausedQtyZero: number; sold: number; standard: number }
  snapshot?: Array<{
    asin: string
    status: string
    priority: string
    cadenceHours: number
    activeConsumerCount: number
    sourceVersion: number
    queueSeq: number
  }>
  snapshotStatus?: number
}): CollectorHttp {
  return {
    getJson: async (p: string) => {
      if (p.includes("/reconcile")) {
        return {
          status: 200,
          json: {
            ok: true,
            hash: opts.central.hash,
            count: opts.central.uniqueAsins,
            active: opts.central.active,
            pausedQtyZero: opts.central.pausedQtyZero,
            sold: opts.central.sold,
            standard: opts.central.standard,
          },
        }
      }
      if (p.includes("/events")) return { status: 200, json: { events: [] } }
      if (p.includes("/snapshot")) {
        if (opts.snapshotStatus && opts.snapshotStatus !== 200) return { status: opts.snapshotStatus, json: { ok: false } }
        return {
          status: 200,
          json: {
            items: opts.snapshot ?? [],
            watermark: { snapshotStartedAt: "2026-01-01T00:00:00.000Z" },
            nextCursor: null,
            offsetSeq: (opts.snapshot ?? []).length,
          },
        }
      }
      return { status: 404, json: {} }
    },
    postJson: async () => ({ status: 200, json: { ok: true } }),
  }
}

function keepaFetch(tokensLeft = 500) {
  let calls = 0
  let lastRequested = 0
  let lastConsumed = 0
  const fn = async (input: { asins: string[] }) => {
    calls++
    const n = input.asins.length
    lastRequested = n
    lastConsumed = n
    return {
      ok: true as const,
      status: 200,
      durationMs: 5,
      body: {
        tokensLeft: tokensLeft - n,
        tokensConsumed: n,
        refillRate: 20,
        refillIn: 1000,
        products: input.asins.map(a => ({
          asin: a,
          csv: [[], [], [1000], [], [], [], [], [], [], [], [], [1], [1]] as unknown as number[][],
          stats: { current: [1000, -1, 1000], buyBoxSellerId: "A1" } as Record<string, unknown>,
        })),
      },
    }
  }
  return { fn, calls: () => calls, lastRequested: () => lastRequested, lastConsumed: () => lastConsumed }
}

function fixture1(): void {
  const now = Date.now()
  const sleep = nextDaemonSleepMs({
    skipped: "NO_DUE",
    waitMs: 0,
    keepaCalls: 0,
    pollMs: 15_000,
    nextDueAtMs: now + 30_000,
    nowMs: now,
  })
  check("1.nextDue-30s-recalc", sleep >= 250 && sleep <= 30_000, sleep)
}

function fixture2(): void {
  const now = Date.now()
  const sleep = nextDaemonSleepMs({
    skipped: "NO_DUE",
    waitMs: 0,
    keepaCalls: 0,
    pollMs: 15_000,
    nextDueAtMs: now + 12 * 3600_000,
    nowMs: now,
  })
  check("2.12h-capped-60s", sleep === KEEPA_MAX_IDLE_SLEEP_MS, sleep)
}

function fixture3(): void {
  const dir = tmpDir()
  const { db } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), priority: "SOLD", nowMs: now, lastScanned: now - 60_000, nextScan: now + 12 * 3600_000 })
  const dueBefore = countDueAsins(db, now).total
  const sleepCap = nextDaemonSleepMs({
    skipped: "NO_DUE",
    waitMs: 0,
    keepaCalls: 0,
    pollMs: 3600_000,
    nextDueAtMs: nextDueAtMs(db, now),
    nowMs: now,
  })
  applySyncEvent(db, {
    eventId: "new-1",
    asin: asin(2),
    eventType: "ASIN_UPSERT",
    sourceVersion: 1,
    payload: { activeConsumerCount: 1, status: "ACTIVE", priority: "SOLD", cadenceHours: 12 },
    nowMs: now,
  })
  const dueAfter = countDueAsins(db, now)
  check("3.event-seen-due", dueBefore === 0 && dueAfter.sold >= 1, { dueBefore, dueAfter })
  check("3.sleep-le-60s", sleepCap <= KEEPA_MAX_IDLE_SLEEP_MS && KEEPA_MAX_IDLE_SLEEP_MS === 60_000, sleepCap)
  fs.rmSync(dir, { recursive: true, force: true })
}

function fixture4(): void {
  const dir = tmpDir()
  const { db } = openDb(dir)
  const now = Date.now()
  insertAsin(db, {
    asin: asin(1),
    priority: "SOLD",
    nowMs: now,
    lastScanned: now - 12 * 3600_000,
    nextScan: now + 365 * 24 * 3600_000,
  })
  const due = countDueAsins(db, now)
  check("4.sold-12h-due-ignores-next-scan", due.sold === 1 && due.total === 1, due)
  fs.rmSync(dir, { recursive: true, force: true })
}

function fixture5(): void {
  const dir = tmpDir()
  const { db } = openDb(dir)
  const now = Date.now()
  insertAsin(db, {
    asin: asin(1),
    priority: "STANDARD",
    nowMs: now,
    lastScanned: now - 24 * 3600_000,
    nextScan: now + 365 * 24 * 3600_000,
  })
  const due = countDueAsins(db, now)
  check("5.standard-24h-due", due.standard === 1 && due.total === 1, due)
  fs.rmSync(dir, { recursive: true, force: true })
}

function fixture6(): void {
  const dir = tmpDir()
  const { db } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), status: "PAUSED_QTY_ZERO", priority: "SOLD", nowMs: now, lastScanned: null })
  insertAsin(db, { asin: asin(2), status: "REMOVED", priority: "STANDARD", nowMs: now, lastScanned: null })
  insertAsin(db, { asin: asin(3), status: "PAUSED", priority: "SOLD", nowMs: now, lastScanned: null })
  const due = countDueAsins(db, now)
  const rows = dueAsins(db, now, 10)
  check("6.paused-removed-excluded", due.total === 0 && rows.length === 0, { due, rows })
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture7(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), priority: "SOLD", nowMs: now, lastScanned: null })
  const man = markReconciled(db)
  setWorkerState(db, "last_tokens_left", "250")
  setWorkerState(db, "last_token_sampled_at", String(now))
  setWorkerState(db, "last_refill_rate", "20")
  setWorkerState(db, "last_refill_in", "1000")
  const http = mockHttp({ central: localReconcileManifest(db) })
  const fetch = keepaFetch(250)
  const scan = await scanDueAsins(cfgFor(dbPath), db, { keepaFetch: fetch.fn as never, http, nowMs: now })
  check("7.due-and-tokens-start-batch", fetch.calls() === 1 && scan.keepaCalls === 1 && scan.skipped == null, scan)
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture8(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), priority: "SOLD", nowMs: now, lastScanned: null })
  const man = markReconciled(db)
  setWorkerState(db, "last_tokens_left", "100")
  setWorkerState(db, "last_token_sampled_at", String(now))
  setWorkerState(db, "last_refill_rate", "20")
  setWorkerState(db, "last_refill_in", "500")
  const http = mockHttp({ central: localReconcileManifest(db) })
  const fetch = keepaFetch(120)
  const wait = await scanDueAsins(cfgFor(dbPath), db, { keepaFetch: fetch.fn as never, http, nowMs: now })
  check("8.reserve-waits", wait.skipped === "TOKEN_WAIT" && fetch.calls() === 0, wait)
  const later = now + 10_000
  const projected = projectKeepaTokenState({
    sampledAtMs: now,
    nowMs: later,
    tokensLeft: 100,
    refillRate: 20,
    refillInMs: 500,
  })
  const plan = planKeepaBatch({
    dueCount: 1,
    tokensLeft: projected.tokensLeft,
    reserve: 100,
    knownTelemetry: true,
    refillInMs: projected.refillInMs,
    pollMs: 15_000,
  })
  check("8.refill-then-call", plan.action === "call" && Number(projected.tokensLeft) > 100, { projected, plan })
  fs.rmSync(dir, { recursive: true, force: true })
}

function fixture9(): void {
  const sampled = Date.now() - 2 * 3600_000
  const now = Date.now()
  const projected = projectKeepaTokenState({
    sampledAtMs: sampled,
    nowMs: now,
    tokensLeft: 100,
    refillRate: 20,
    refillInMs: 50_000,
  })
  const plan = planKeepaBatch({
    dueCount: 5,
    tokensLeft: projected.tokensLeft,
    reserve: 100,
    knownTelemetry: true,
    refillInMs: projected.refillInMs,
    pollMs: 15_000,
  })
  const wait = nextDaemonSleepMs({
    skipped: "TOKEN_WAIT",
    waitMs: 3_600_000,
    keepaCalls: 0,
    pollMs: 15_000,
    nowMs: now,
  })
  check("9.stale-sample-not-infinite-wait", plan.action === "call" && wait <= KEEPA_MAX_IDLE_SLEEP_MS, { projected, plan, wait })
}

async function fixture10(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), consumers: 0, nowMs: now, lastScanned: null })
  const target = {
    asin: asin(1),
    status: "ACTIVE",
    priority: "STANDARD",
    cadenceHours: 24,
    activeConsumerCount: 1,
    sourceVersion: 2,
    queueSeq: 1,
  }
  const central = computeKeepaReconcileManifest([
    {
      asin: target.asin,
      status: target.status,
      priority: target.priority,
      cadenceHours: target.cadenceHours,
      activeConsumerCount: target.activeConsumerCount,
      sourceVersion: target.sourceVersion,
    },
  ])
  const http = mockHttp({ central, snapshot: [target] })
  const auto = createAutoRepairState()
  const fetch = keepaFetch(400)
  const pid = process.pid
  const turn = await reconcileThenMaybeAutoRepair({
    cfg: cfgFor(dbPath),
    db,
    http,
    auto,
    lockHeldByThisProcess: true,
    nowMs: now,
  })
  const scan = await scanDueAsins(cfgFor(dbPath), db, { keepaFetch: fetch.fn as never, http, nowMs: now })
  check("10.repair-then-same-pid-scan", turn.repaired && turn.keepaAllowed && process.pid === pid && scan.keepaCalls === 1, {
    turn,
    pid,
    scan,
  })
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture11(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), consumers: 0, nowMs: now, lastScanned: null })
  const target = {
    asin: asin(1),
    status: "ACTIVE",
    priority: "STANDARD",
    cadenceHours: 24,
    activeConsumerCount: 9,
    sourceVersion: 9,
    queueSeq: 1,
  }
  const central = computeKeepaReconcileManifest([
    {
      asin: target.asin,
      status: target.status,
      priority: target.priority,
      cadenceHours: target.cadenceHours,
      activeConsumerCount: target.activeConsumerCount,
      sourceVersion: target.sourceVersion,
    },
  ])
  const http = mockHttp({ central, snapshot: [target], snapshotStatus: 500 })
  const auto = createAutoRepairState()
  const turn = await reconcileThenMaybeAutoRepair({
    cfg: cfgFor(dbPath),
    db,
    http,
    auto,
    lockHeldByThisProcess: true,
    nowMs: now,
  })
  check("11.repair-fail-backoff-60s", turn.repaired === false && !turn.keepaAllowed && turn.waitMs === KEEPA_AUTO_REPAIR_BACKOFF_MS, turn)
  const t0 = 1_000_000
  const a = dueWorkStallAdvance({
    previous: 0,
    stallStartedAtMs: null,
    nowMs: t0,
    dueCount: 1,
    spendable: 5,
    keepaAllowed: true,
    progressed: false,
  })
  const b = dueWorkStallAdvance({
    previous: a.stallLoops,
    stallStartedAtMs: a.stallStartedAtMs,
    nowMs: t0 + 15_000,
    dueCount: 1,
    spendable: 5,
    keepaAllowed: true,
    progressed: false,
  })
  const cFast = dueWorkStallAdvance({
    previous: b.stallLoops,
    stallStartedAtMs: b.stallStartedAtMs,
    nowMs: t0 + 31_000,
    dueCount: 1,
    spendable: 5,
    keepaAllowed: true,
    progressed: false,
  })
  const c = dueWorkStallAdvance({
    previous: b.stallLoops,
    stallStartedAtMs: b.stallStartedAtMs,
    nowMs: t0 + KEEPA_STALL_MIN_WALL_MS,
    dueCount: 1,
    spendable: 5,
    keepaAllowed: true,
    progressed: false,
  })
  check("11.three-fast-loops-no-exit", a.shouldExit === false && b.shouldExit === false && cFast.shouldExit === false, {
    a,
    b,
    cFast,
  })
  check("11.three-loops-wall-exit", c.shouldExit === true, c)
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture12(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), priority: "SOLD", nowMs: now, lastScanned: now, nextScan: now + 12 * 3600_000 })
  markReconciled(db)
  enqueueObservationOutbox(db, {
    fingerprint: "fp-obs-1",
    asin: asin(1),
    payloadJson: JSON.stringify({ kind: "keepa-observation", asin: asin(1) }),
    nowMs: now,
  })
  setWorkerState(db, "last_tokens_left", "400")
  const http = mockHttp({ central: localReconcileManifest(db) })
  const fetch = keepaFetch(400)
  const scan = await scanDueAsins(cfgFor(dbPath), db, { keepaFetch: fetch.fn as never, http, nowMs: now })
  check("12.observation-retry-no-rescan", fetch.calls() === 0 && (scan.skipped === "NO_DUE" || scan.keepaCalls === 0), scan)
  fs.rmSync(dir, { recursive: true, force: true })
}

function fixture13(): void {
  const spendable = spendableTokens(199, 100)
  const plan = planKeepaBatch({ dueCount: 200, tokensLeft: 199, reserve: 100, knownTelemetry: true, pollMs: 15_000 })
  check("13.reserve-floor", spendable === 99 && plan.action === "call" && plan.batch <= 99, { spendable, plan })
  check("13.tokens-never-below-reserve", 199 - (plan.action === "call" ? plan.batch : 0) >= 100, plan)
}

async function fixture14(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  for (let i = 1; i <= 150; i++) insertAsin(db, { asin: asin(i), priority: "SOLD", nowMs: now, lastScanned: null })
  markReconciled(db)
  setWorkerState(db, "last_tokens_left", "400")
  setWorkerState(db, "last_token_sampled_at", String(now))
  const http = mockHttp({ central: localReconcileManifest(db) })
  const fetch = keepaFetch(400)
  const scan = await scanDueAsins(cfgFor(dbPath), db, { keepaFetch: fetch.fn as never, http, nowMs: now })
  check(
    "14.batch-le-100-consumed-le-requested",
    fetch.calls() === 1 && fetch.lastRequested() <= 100 && fetch.lastConsumed() <= fetch.lastRequested() && scan.requested === fetch.lastRequested(),
    { requested: fetch.lastRequested(), consumed: fetch.lastConsumed(), scan }
  )
  fs.rmSync(dir, { recursive: true, force: true })
}

function fixture15(): void {
  const dir = tmpDir()
  const { db } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), priority: "SOLD", nowMs: now, lastScanned: now, nextScan: now + 12 * 3600_000 })
  const due = countDueAsins(db, now)
  const nextDue = nextDueAtMs(db, now)
  const mode = keepaScanMode({ dueCount: due.total, spendable: 500 })
  const sleep = nextDaemonSleepMs({
    skipped: "NO_DUE",
    waitMs: 0,
    keepaCalls: 0,
    pollMs: 15_000,
    nextDueAtMs: nextDue,
    nowMs: now,
  })
  const stall = dueWorkStallAdvance({ previous: 2, dueCount: 0, progressed: false })
  check("15.cadence-wait-not-stall", due.total === 0 && mode === "CADENCE_WAIT" && nextDue != null && nextDue > now && sleep <= 60_000 && stall.shouldExit === false, {
    due,
    mode,
    nextDue,
    sleep,
    stall,
  })
  fs.rmSync(dir, { recursive: true, force: true })
}

async function main(): Promise<void> {
  fixture1()
  fixture2()
  fixture3()
  fixture4()
  fixture5()
  fixture6()
  await fixture7()
  await fixture8()
  fixture9()
  await fixture10()
  await fixture11()
  await fixture12()
  fixture13()
  await fixture14()
  fixture15()
  if (failed) {
    console.error(`FAILED ${failed}`)
    process.exit(1)
  }
  console.log("DAEMON_FIXTURES_PASSED")
}

void main()
