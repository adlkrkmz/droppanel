import fs from "fs"
import os from "os"
import path from "path"
import { computeKeepaReconcileManifest } from "../modules/keepaSensor/keepaCollectorReconcile"
import {
  applySyncEvent,
  enqueueObservationOutbox,
  getWorkerState,
  localReconcileManifest,
  localReconcileRows,
  openKeepaLocalDb,
  pendingAckCount,
  recordKeepaTokenSample,
  setBootstrapPhase,
  setWorkerState,
} from "../modules/keepaSensor/keepaLocalDb"
import { loadKeepaCollectorConfig, scanDueAsins } from "../modules/keepaSensor/keepaCollectorLoop"
import {
  createAutoRepairState,
  evaluateAutoRepairGate,
  KEEPA_AUTO_REPAIR_BACKOFF_MS,
  reconcileThenMaybeAutoRepair,
} from "../modules/keepaSensor/keepaCollectorAutoRepair"
import { collectorLockPath } from "../modules/keepaSensor/keepaCollectorLock"
import type { CollectorHttp } from "../modules/keepaSensor/keepaCollectorBootstrap"

type Central = ReturnType<typeof computeKeepaReconcileManifest> & { items?: SnapshotItem[] }

type SnapshotItem = {
  asin: string
  status: string
  priority: string
  cadenceHours: number
  activeConsumerCount: number
  sourceVersion: number
  queueSeq: number
}

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "keepa-ar-"))
}

function openDb(dir: string) {
  const dbPath = path.join(dir, "keepa-worker.sqlite")
  const db = openKeepaLocalDb(dbPath)
  setBootstrapPhase(db, "COMPLETE")
  return { db, dbPath }
}

function cfgFor(dbPath: string, extra: Record<string, string> = {}) {
  return loadKeepaCollectorConfig({
    LISTJETGO_API_BASE: "http://127.0.0.1",
    KEEPA_COLLECTOR_WORKER_TOKEN: "T".repeat(32),
    KEEPA_API_KEY: "K".repeat(20),
    KEEPA_LOCAL_DB_PATH: dbPath,
    KEEPA_COLLECTOR_ENABLED: "true",
    KEEPA_COLLECTOR_RUN_MODE: "daemon",
    KEEPA_ENABLED: "true",
    KEEPA_TOKEN_RESERVE: "100",
    KEEPA_COLLECTOR_POLL_MS: "3600000",
    KEEPA_COLLECTOR_BATCH_SIZE: "100",
    KEEPA_COLLECTOR_MAX_BATCHES: "1",
    ...extra,
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
    version?: number
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
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(
    row.asin,
    row.consumers ?? 1,
    row.status ?? "ACTIVE",
    row.priority ?? "STANDARD",
    row.cadence ?? 24,
    row.nextScan ?? nowMs - 1000,
    row.version ?? 1,
    nowMs,
    nowMs,
    row.lastScanned === undefined ? null : row.lastScanned
  )
}

function centralFromDb(db: ReturnType<typeof openKeepaLocalDb>) {
  return computeKeepaReconcileManifest(localReconcileRows(db))
}

function snapshotItemsFrom(rows: SnapshotItem[]): SnapshotItem[] {
  return [...rows].sort((a, b) => (a.asin < b.asin ? -1 : 1))
}

function mockHttp(opts: {
  central: { hash: string; uniqueAsins: number; active: number; pausedQtyZero: number; sold: number; standard: number }
  events?: Array<Record<string, unknown>>
  snapshot?: SnapshotItem[]
  snapshotStatus?: number
  snapshotLoop?: boolean
  reconcileStatus?: number
  repairCompleteOk?: boolean
  repairCompleteStatus?: number
  ackStatus?: number
}): CollectorHttp & { keepaProductGets: number; snapshotGets: number; repairCompletes: number } {
  const events = [...(opts.events ?? [])]
  let eventsDrained = false
  const state = { keepaProductGets: 0, snapshotGets: 0, repairCompletes: 0 }
  const http: CollectorHttp & typeof state = {
    keepaProductGets: 0,
    snapshotGets: 0,
    repairCompletes: 0,
    getJson: async (p: string) => {
      if (p.includes("/reconcile")) {
        return {
          status: opts.reconcileStatus ?? 200,
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
      if (p.includes("/events")) {
        if (eventsDrained) return { status: 200, json: { events: [] } }
        eventsDrained = true
        return { status: 200, json: { events } }
      }
      if (p.includes("/snapshot")) {
        state.snapshotGets++
        http.snapshotGets = state.snapshotGets
        if (opts.snapshotStatus && opts.snapshotStatus !== 200) {
          return { status: opts.snapshotStatus, json: { ok: false } }
        }
        if (opts.snapshotLoop) {
          return {
            status: 200,
            json: {
              items: opts.snapshot ?? [],
              watermark: { snapshotStartedAt: "2026-01-01T00:00:00.000Z" },
              nextCursor: "AAAA",
              offsetSeq: 0,
            },
          }
        }
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
    postJson: async (p: string) => {
      if (p.includes("/ack")) return { status: opts.ackStatus ?? 200, json: { ok: true } }
      if (p.includes("/repair-complete")) {
        state.repairCompletes++
        http.repairCompletes = state.repairCompletes
        return {
          status: opts.repairCompleteStatus ?? 200,
          json: { ok: opts.repairCompleteOk !== false },
        }
      }
      if (p.includes("/heartbeat") || p.includes("/observations")) return { status: 200, json: { ok: true } }
      return { status: 200, json: { ok: true } }
    },
  }
  return http
}

function keepaFetch(tokensLeft = 500) {
  let calls = 0
  const fn = async (input: { asins: string[] }) => {
    calls++
    const n = input.asins.length
    return {
      ok: true as const,
      status: 200,
      durationMs: 5,
      body: {
        tokensLeft: tokensLeft - n,
        tokensConsumed: n,
        refillRate: 20,
        refillIn: 50000,
        products: input.asins.map(a => ({
          asin: a,
          csv: [[], [], [1000], [], [], [], [], [], [], [], [], [1], [1]] as unknown as number[][],
          stats: { current: [1000, -1, 1000], buyBoxSellerId: "A1" } as Record<string, unknown>,
        })),
      },
    }
  }
  return { fn, calls: () => calls }
}

async function fixture1(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), nowMs: now, nextScan: now - 1000 })
  const man = centralFromDb(db)
  setWorkerState(db, "central_reconcile_hash", man.hash)
  setWorkerState(db, "central_reconcile_count", String(man.uniqueAsins))
  setWorkerState(db, "last_tokens_left", "400")
  const http = mockHttp({ central: man, snapshot: snapshotItemsFrom([{ asin: asin(1), status: "ACTIVE", priority: "STANDARD", cadenceHours: 24, activeConsumerCount: 1, sourceVersion: 1, queueSeq: 1 }]) })
  const auto = createAutoRepairState()
  const fetch = keepaFetch(400)
  const turn = await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true, nowMs: now })
  const scan = await scanDueAsins(cfgFor(dbPath), db, { keepaFetch: fetch.fn as never, http, nowMs: now })
  check("1.match-no-repair", turn.repaired === false && turn.repairAttempts === 0 && turn.keepaAllowed)
  check("1.scan-continues", fetch.calls() === 1 && scan.keepaCalls === 1)
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture2(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), consumers: 0, nowMs: now })
  const target = {
    asin: asin(1),
    status: "ACTIVE",
    priority: "STANDARD",
    cadenceHours: 24,
    activeConsumerCount: 1,
    sourceVersion: 2,
    queueSeq: 1,
  }
  const events = [
    {
      eventId: "e1",
      asin: asin(1),
      eventType: "CONSUMER_ATTACHED",
      sourceVersion: 2,
      createdAt: "2026-01-02T00:00:00.000Z",
      payload: { activeConsumerCount: 1, status: "ACTIVE", priority: "STANDARD", cadenceHours: 24 },
    },
  ]
  const fakeDbItems = [target]
  const central = computeKeepaReconcileManifest(
    fakeDbItems.map(r => ({
      asin: r.asin,
      status: r.status,
      priority: r.priority,
      cadenceHours: r.cadenceHours,
      activeConsumerCount: r.activeConsumerCount,
      sourceVersion: r.sourceVersion,
    }))
  )
  const http = mockHttp({
    central,
    events,
    snapshot: snapshotItemsFrom([target]),
  })
  const auto = createAutoRepairState()
  const fetch = keepaFetch()
  const turn = await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true, nowMs: now })
  check("2.catchup-closes", turn.keepaAllowed && turn.repaired === false && turn.repairAttempts === 0 && http.snapshotGets === 0)
  check("2.no-keepa-during-sync", fetch.calls() === 0 && turn.keepaCalls === 0)
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture3(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), consumers: 0, nowMs: now, lastScanned: 111 })
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
  const http = mockHttp({ central, snapshot: snapshotItemsFrom([target]) })
  const auto = createAutoRepairState()
  const fetch = keepaFetch(500)
  const turn = await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true, nowMs: now })
  check("3.repair-once", turn.repaired && turn.repairAttempts === 1 && turn.keepaAllowed && http.snapshotGets >= 1)
  check("3.keepa-zero-during-repair", turn.keepaCalls === 0)
  const local = localReconcileManifest(db)
  check("3.hash-match", local.hash === central.hash && local.uniqueAsins === central.uniqueAsins)
  const scan = await scanDueAsins(cfgFor(dbPath), db, { keepaFetch: fetch.fn as never, http, nowMs: now })
  check("3.scan-after-repair", fetch.calls() === 1 && scan.keepaCalls === 1)
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture4(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), consumers: 0, nowMs: now, lastScanned: 222 })
  const before = db.prepare("SELECT * FROM asin_registry WHERE asin=?").get(asin(1))
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
  const http = mockHttp({ central, snapshot: snapshotItemsFrom([target]), snapshotStatus: 500 })
  const auto = createAutoRepairState()
  const fetch = keepaFetch()
  const turn = await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true, nowMs: now })
  const after = db.prepare("SELECT * FROM asin_registry WHERE asin=?").get(asin(1))
  check("4.repair-fail", turn.repaired === false && turn.repairAttempts === 1 && !turn.keepaAllowed)
  check("4.registry-unchanged", JSON.stringify(before) === JSON.stringify(after))
  check("4.keepa-zero", turn.keepaCalls === 0 && fetch.calls() === 0)
  check("4.backoff-60s", turn.waitMs === KEEPA_AUTO_REPAIR_BACKOFF_MS)
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture5(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), consumers: 0, nowMs: now })
  applySyncEvent(
    db,
    {
      eventId: "pending-1",
      asin: asin(1),
      eventType: "CONSUMER_ATTACHED",
      sourceVersion: 2,
      payload: { activeConsumerCount: 1, status: "ACTIVE", priority: "STANDARD", cadenceHours: 24 },
      nowMs: now,
    },
    { recordSync: true, remoteAckStatus: "PENDING_ACK" }
  )
  const man = localReconcileManifest(db)
  const central = computeKeepaReconcileManifest([
    {
      asin: asin(1),
      status: "ACTIVE",
      priority: "STANDARD",
      cadenceHours: 24,
      activeConsumerCount: 9,
      sourceVersion: 9,
    },
  ])
  const http = mockHttp({ central, snapshot: [], ackStatus: 500 })
  const auto = createAutoRepairState()
  const turn = await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true, nowMs: now })
  check("5.pending-ack-no-repair", pendingAckCount(db) > 0 && turn.repairAttempts === 0 && turn.repaired === false)
  check("5.no-snapshot", http.snapshotGets === 0)
  void man
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture6(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  insertAsin(db, { asin: asin(1) })
  const man = localReconcileManifest(db)
  const http = mockHttp({ central: man, reconcileStatus: 401 })
  const auto = createAutoRepairState()
  const fetch = keepaFetch()
  const turn = await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true })
  check("6.no-repair", turn.repairAttempts === 0 && http.snapshotGets === 0)
  check("6.fail-closed", turn.keepaStopped === true && fetch.calls() === 0)
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture7(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), consumers: 0, nowMs: now, lastScanned: 333 })
  const before = db.prepare("SELECT * FROM asin_registry").all()
  const target = {
    asin: asin(1),
    status: "ACTIVE",
    priority: "STANDARD",
    cadenceHours: 24,
    activeConsumerCount: 2,
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
  const http = mockHttp({ central, snapshot: snapshotItemsFrom([target]), snapshotLoop: true })
  const auto = createAutoRepairState()
  const turn = await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true, nowMs: now })
  const after = db.prepare("SELECT * FROM asin_registry").all()
  check("7.no-swap", JSON.stringify(before) === JSON.stringify(after))
  check("7.repair-not-ok", turn.keepaAllowed === false && turn.repaired === false)
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture8(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  insertAsin(db, { asin: asin(1), consumers: 0 })
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
  const http = mockHttp({ central, snapshot: snapshotItemsFrom([target]) })
  const auto = createAutoRepairState()
  fs.writeFileSync(collectorLockPath(dbPath), "1\n")
  const turn = await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: false })
  check("8.lock-other", turn.repairAttempts === 0 && http.snapshotGets === 0 && turn.gateReason === "LOCK_OTHER_PROCESS")
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture9(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), consumers: 0, nowMs: now, nextScan: 555000, lastScanned: 444000 })
  recordKeepaTokenSample(db, {
    collectedAt: now,
    tokensLeft: 200,
    refillRate: 20,
    refillIn: 1000,
    tokensConsumed: 0,
    tokenFlowReduction: null,
    processingTimeInMs: 1,
    httpStatus: 200,
    requested: 0,
    returned: 0,
    parsed: 0,
  })
  enqueueObservationOutbox(db, {
    fingerprint: "fp-keep",
    asin: asin(1),
    payloadJson: "{}",
    nowMs: now,
  })
  applySyncEvent(
    db,
    {
      eventId: "acked-keep",
      asin: asin(1),
      eventType: "CONSUMER_ATTACHED",
      sourceVersion: 1,
      payload: { activeConsumerCount: 0, status: "ACTIVE", priority: "STANDARD", cadenceHours: 24 },
      nowMs: now - 1,
    },
    { recordSync: true, remoteAckStatus: "ACKED_REMOTE" }
  )
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
  const http = mockHttp({ central, snapshot: snapshotItemsFrom([target]) })
  const auto = createAutoRepairState()
  const turn = await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true, nowMs: now })
  const row = db.prepare("SELECT last_scanned_at, next_scan_at FROM asin_registry WHERE asin=?").get(asin(1)) as {
    last_scanned_at: number
    next_scan_at: number
  }
  check("9.repair-ok", turn.repaired === true)
  check("9.preserve-scan-times", row.last_scanned_at === 444000 && row.next_scan_at === 555000)
  check("9.preserve-samples", (db.prepare("SELECT COUNT(*) AS c FROM keepa_token_samples").get() as { c: number }).c === 1)
  check("9.preserve-outbox", (db.prepare("SELECT COUNT(*) AS c FROM keepa_observation_outbox").get() as { c: number }).c === 1)
  check("9.preserve-ledger", (db.prepare("SELECT COUNT(*) AS c FROM sync_events").get() as { c: number }).c >= 1)
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture10(): Promise<void> {
  const gate = evaluateAutoRepairGate({
    runMode: "daemon",
    phase: "COMPLETE",
    integrityOk: true,
    lockHeldByThisProcess: true,
    pendingAck: 0,
    catchUpComplete: true,
    centralReachable: true,
    mismatch: true,
    inFlight: true,
    lastError: "SYNC_RECONCILE_MISMATCH",
    nowMs: Date.now(),
    lastFailAtMs: 0,
  })
  check("10.in-flight-blocks", gate.repairNow === false && gate.reason === "REPAIR_IN_FLIGHT")
}

async function fixture11(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), consumers: 0, nowMs: now })
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
  const http = mockHttp({ central, snapshot: snapshotItemsFrom([target]) })
  const auto = createAutoRepairState()
  const first = await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true, nowMs: now })
  const snaps = http.snapshotGets
  const second = await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true, nowMs: now + 1 })
  check("11.first-repair", first.repaired === true)
  check("11.second-no-repair", second.repaired === false && second.repairAttempts === 0 && http.snapshotGets === snaps)
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture12(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), nowMs: now, nextScan: now + 86400000, lastScanned: now })
  const man = centralFromDb(db)
  setWorkerState(db, "central_reconcile_hash", man.hash)
  setWorkerState(db, "central_reconcile_count", String(man.uniqueAsins))
  setWorkerState(db, "last_tokens_left", "400")
  const http = mockHttp({ central: man, snapshot: [] })
  const auto = createAutoRepairState()
  const fetch = keepaFetch()
  const turn = await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true, nowMs: now })
  const scan = await scanDueAsins(cfgFor(dbPath), db, { keepaFetch: fetch.fn as never, http, nowMs: now })
  check("12.no-due-no-keepa", turn.keepaAllowed && fetch.calls() === 0 && scan.keepaCalls === 0 && scan.skipped === "NO_DUE")
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture13(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), consumers: 0, nowMs: now, nextScan: now - 1 })
  setWorkerState(db, "last_tokens_left", "500")
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
  const http = mockHttp({ central, snapshot: snapshotItemsFrom([target]) })
  const auto = createAutoRepairState()
  const fetch = keepaFetch(500)
  const turn = await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true, nowMs: now })
  const scan = await scanDueAsins(cfgFor(dbPath), db, { keepaFetch: fetch.fn as never, http, nowMs: now })
  check("13.same-turn-keepa", turn.repaired && turn.keepaAllowed && fetch.calls() === 1 && scan.keepaCalls === 1)
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture14(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), status: "ACTIVE", nowMs: now, nextScan: now - 1 })
  insertAsin(db, { asin: asin(2), status: "PAUSED_QTY_ZERO", cadence: 12, nowMs: now, nextScan: now - 1 })
  insertAsin(db, { asin: asin(3), status: "REMOVED", nowMs: now, nextScan: now - 1 })
  const man = centralFromDb(db)
  setWorkerState(db, "central_reconcile_hash", man.hash)
  setWorkerState(db, "central_reconcile_count", String(man.uniqueAsins))
  setWorkerState(db, "last_tokens_left", "400")
  const http = mockHttp({ central: man })
  const auto = createAutoRepairState()
  await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true, nowMs: now })
  const seen: string[] = []
  const fetch = {
    fn: async (input: { asins: string[] }) => {
      seen.push(...input.asins)
      return keepaFetch(400).fn(input)
    },
  }
  await scanDueAsins(cfgFor(dbPath), db, { keepaFetch: fetch.fn as never, http, nowMs: now })
  check("14.only-active", seen.length === 1 && seen[0] === asin(1))
  fs.rmSync(dir, { recursive: true, force: true })
}

async function fixture15(): Promise<void> {
  const dir = tmpDir()
  const { db, dbPath } = openDb(dir)
  const now = Date.now()
  insertAsin(db, { asin: asin(1), nowMs: now, nextScan: now - 1 })
  const man = centralFromDb(db)
  setWorkerState(db, "central_reconcile_hash", man.hash)
  setWorkerState(db, "central_reconcile_count", String(man.uniqueAsins))
  setWorkerState(db, "last_tokens_left", "100")
  setWorkerState(db, "last_token_sampled_at", String(now))
  setWorkerState(db, "last_refill_in", "50000")
  setWorkerState(db, "last_refill_rate", "20")
  const http = mockHttp({ central: man })
  const auto = createAutoRepairState()
  await reconcileThenMaybeAutoRepair({ cfg: cfgFor(dbPath), db, http, auto, lockHeldByThisProcess: true, nowMs: now })
  const fetch = keepaFetch(100)
  const scan = await scanDueAsins(cfgFor(dbPath), db, { keepaFetch: fetch.fn as never, http, nowMs: now })
  check("15.reserve-no-call", fetch.calls() === 0 && (scan.skipped === "TOKEN_WAIT" || scan.spendable === 0))
  fs.rmSync(dir, { recursive: true, force: true })
}

async function main(): Promise<void> {
  await fixture1()
  await fixture2()
  await fixture3()
  await fixture4()
  await fixture5()
  await fixture6()
  await fixture7()
  await fixture8()
  await fixture9()
  await fixture10()
  await fixture11()
  await fixture12()
  await fixture13()
  await fixture14()
  await fixture15()
  if (failed) {
    console.error(`FAILED ${failed}`)
    process.exit(1)
  }
  console.log("PASS keepaCollectorAutoRepair 15/15")
  console.log("ALL_FIXTURES_PASSED")
}

void main()
