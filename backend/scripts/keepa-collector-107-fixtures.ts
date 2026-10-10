import assert from "assert"
import {
  applySyncEvent,
  bootstrapPhase,
  candidateCount,
  dueAsins,
  getWorkerState,
  keepaScanAllowed,
  localReconcileManifest,
  openKeepaLocalDb,
  pendingAckCount,
  registryCount,
  saveSnapshot,
  setWorkerState,
  snapshotCount,
  type SnapshotItem,
} from "../modules/keepaSensor/keepaLocalDb"
import { CrashSimError, type CollectorHttp } from "../modules/keepaSensor/keepaCollectorBootstrap"
import { catchUpLifecycleThenReconcile } from "../modules/keepaSensor/keepaCollectorEventSync"
import { runCollectorRepair } from "../modules/keepaSensor/keepaCollectorRepair"
import { computeKeepaReconcileManifest } from "../modules/keepaSensor/keepaCollectorReconcile"
import { keepaCollectorDashboardFromRow } from "../modules/amazonScan/keepaCollectorDashboard"
import { keepaDirectMutationsEnabled } from "../modules/keepaSensor/keepaDirectMutationGate"
import {
  loadKeepaCollectorConfig,
  runKeepaCollector,
} from "../modules/keepaSensor/keepaCollectorLoop"
import { telemetryContainsForbidden } from "../modules/keepaSensor/keepaCollectorTelemetry"
import { KEEPA_COLLECTOR_VERSION } from "../modules/keepaSensor/keepaCollectorVersion"

const LOCAL_N = 12732
const EXTRA = 4
const t0 = "2026-09-21T18:05:08.146Z"
const tLate = "2026-09-21T18:06:00.000Z"
const tSnap = "2026-09-22T06:00:00.000Z"
const nowMs = Date.parse("2026-09-22T06:10:00.000Z")

function asinAt(i: number): string {
  return `B0${String(10000000 + i).slice(-8)}`
}

function item(asin: string, extra: Partial<SnapshotItem> = {}): SnapshotItem {
  return {
    asin,
    activeConsumerCount: 1,
    status: "ACTIVE",
    priority: extra.priority ?? "STANDARD",
    cadenceHours: extra.priority === "SOLD" ? 12 : 24,
    sourceVersion: extra.sourceVersion ?? 1,
    queueSeq: extra.queueSeq ?? 1,
    ...extra,
  }
}

function seedLocal(db: ReturnType<typeof openKeepaLocalDb>, n: number): void {
  db.exec("BEGIN")
  const ins = db.prepare(
    `INSERT INTO asin_registry (
       asin, active_consumer_count, status, priority, cadence_hours, next_scan_at,
       source_version, queue_seq, created_at, updated_at, last_scanned_at
     ) VALUES (?, 1, 'ACTIVE', 'STANDARD', 24, ?, 1, ?, ?, ?, ?)`
  )
  for (let i = 0; i < n; i++) {
    ins.run(asinAt(i), 1_000_000 + i * 1000, i + 1, 1_000_000, 1_000_000, nowMs)
  }
  db.exec("COMMIT")
  setWorkerState(db, "bootstrap_status", "COMPLETE")
  setWorkerState(db, "bootstrap_phase", "COMPLETE")
  setWorkerState(db, "snapshot_started_at", t0)
  const local = localReconcileManifest(db)
  setWorkerState(db, "central_reconcile_hash", local.hash)
  setWorkerState(db, "central_reconcile_count", String(local.uniqueAsins))
}

function ev(idTail: string, asin: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb${idTail}`,
    asin,
    eventType: extra.eventType ?? "ASIN_UPSERT",
    sourceVersion: extra.sourceVersion ?? 2,
    createdAt: extra.createdAt ?? tLate,
    status: extra.status ?? "PENDING",
    payload:
      extra.payload ??
      { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
  }
}

function pagesOf(items: SnapshotItem[], size = 200): SnapshotItem[][] {
  const pages: SnapshotItem[][] = []
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size))
  return pages
}

type MockCtl = {
  http: CollectorHttp
  ackCalls: number
  keepaCalls: number
  heartbeatPosts: number
  payloads: Record<string, unknown>[]
  receipts: Record<string, unknown>[]
  coveredMutations: number
  force409: boolean
  events: Record<string, unknown>[]
  injectEvent: (row: Record<string, unknown>) => void
}

function materializeLive(
  seed: SnapshotItem[],
  extras: SnapshotItem[],
  events: Record<string, unknown>[],
  untilCreatedAt?: string
): SnapshotItem[] {
  const live = new Map<string, SnapshotItem>()
  for (const row of [...seed, ...extras]) live.set(row.asin, { ...row })
  const ordered = [...events]
    .filter(e => e.status !== "COVERED_BY_SNAPSHOT")
    .filter(e => !untilCreatedAt || String(e.createdAt) <= untilCreatedAt)
    .sort((a, b) => {
      const byTime = String(a.createdAt).localeCompare(String(b.createdAt))
      return byTime !== 0 ? byTime : String(a.eventId).localeCompare(String(b.eventId))
    })
  for (const row of ordered) {
    const asin = String(row.asin)
    const eventType = String(row.eventType)
    const payload = (row.payload ?? {}) as Record<string, unknown>
    if (eventType === "ASIN_REMOVED" || payload.status === "REMOVED") {
      live.delete(asin)
      continue
    }
    const prev = live.get(asin)
    live.set(asin, {
      asin,
      activeConsumerCount: Number(payload.activeConsumerCount ?? prev?.activeConsumerCount ?? 1),
      status: String(payload.status ?? prev?.status ?? "ACTIVE"),
      priority: String(payload.priority ?? prev?.priority ?? "STANDARD"),
      cadenceHours: Number(payload.cadenceHours ?? prev?.cadenceHours ?? 24),
      sourceVersion: Number(row.sourceVersion ?? prev?.sourceVersion ?? 1),
      queueSeq: prev?.queueSeq ?? live.size,
    })
  }
  return [...live.values()].sort((a, b) => a.asin.localeCompare(b.asin))
}

function mockWorld(seed: SnapshotItem[], extras: SnapshotItem[], initialEvents: Record<string, unknown>[]): MockCtl {
  const events = [...initialEvents]
  const remoteAcked = new Set<string>()
  const ctl: MockCtl = {
    ackCalls: 0,
    keepaCalls: 0,
    heartbeatPosts: 0,
    payloads: [],
    receipts: [],
    coveredMutations: 0,
    force409: false,
    events,
    injectEvent: row => events.push(row),
    http: {
      async getJson(pathName: string) {
        if (pathName.startsWith("/internal/keepa-collector/snapshot")) {
          const url = new URL(pathName, "http://local")
          const cursor = url.searchParams.get("cursor") ?? ""
          const pages = pagesOf(materializeLive(seed, extras, events, tSnap))
          const pageIdx = cursor ? pages.findIndex(p => p[p.length - 1]?.asin === cursor) + 1 : 0
          const page = pages[pageIdx] ?? []
          return {
            status: 200,
            json: {
              ok: true,
              items: page,
              nextCursor: pageIdx + 1 < pages.length ? page[page.length - 1].asin : null,
              offsetSeq: page.length,
              watermark: pageIdx === 0 && !cursor ? { snapshotStartedAt: tSnap } : undefined,
            },
          }
        }
        if (pathName.startsWith("/internal/keepa-collector/events")) {
          const url = new URL(pathName, "http://local")
          const since = url.searchParams.get("sinceCreatedAt") ?? ""
          const after = url.searchParams.get("afterEventId") ?? ""
          let list = events.filter(e => e.status !== "COVERED_BY_SNAPSHOT" && e.status !== "DELIVERED")
          list = list.filter(e => String(e.createdAt) >= since)
          if (after) {
            const idx = list.findIndex(e => e.eventId === after)
            list = idx >= 0 ? list.slice(idx + 1) : list
          }
          return { status: 200, json: { ok: true, events: list.slice(0, 100) } }
        }
        if (pathName === "/internal/keepa-collector/reconcile") {
          const manifest = computeKeepaReconcileManifest(materializeLive(seed, extras, events))
          return { status: 200, json: { ok: true, hash: manifest.hash, count: manifest.uniqueAsins } }
        }
        return { status: 404, json: {} }
      },
      async postJson(pathName: string, body?: Record<string, unknown>) {
        if (pathName === "/internal/keepa-collector/heartbeat") {
          ctl.heartbeatPosts++
          ctl.payloads.push(body ?? {})
          return { status: 200, json: { ok: true } }
        }
        if (pathName === "/internal/keepa-collector/ack") {
          ctl.ackCalls++
          const ids = Array.isArray(body?.eventIds) ? (body.eventIds as string[]) : []
          let acked = 0
          let alreadyAcked = 0
          for (const id of ids) {
            if (remoteAcked.has(id)) alreadyAcked++
            else {
              remoteAcked.add(id)
              acked++
            }
          }
          return { status: 200, json: { ok: true, acked, alreadyAcked } }
        }
        if (pathName === "/internal/keepa-collector/bootstrap-complete") {
          ctl.coveredMutations++
          return { status: 200, json: { ok: true, covered: 0 } }
        }
        if (pathName === "/internal/keepa-collector/repair-complete") {
          if (ctl.force409) return { status: 409, json: { ok: false, error: "RECONCILE_MISMATCH" } }
          const id = String(body?.requestId ?? "")
          if (ctl.receipts.some(r => r.requestId === id)) {
            return { status: 200, json: { ok: true, idempotent: true } }
          }
          ctl.receipts.push(body ?? {})
          return { status: 200, json: { ok: true, idempotent: false } }
        }
        return { status: 404, json: {} }
      },
    },
  }
  return ctl
}

function envMode(mode: string): NodeJS.ProcessEnv {
  return {
    KEEPA_COLLECTOR_ENABLED: "true",
    KEEPA_ENABLED: "true",
    KEEPA_COLLECTOR_RUN_MODE: mode,
    KEEPA_COLLECTOR_MAX_BATCHES: "1",
    LISTJETGO_API_BASE: "http://local",
    KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
    KEEPA_API_KEY: "k",
  }
}

async function main(): Promise<void> {
  assert.equal(KEEPA_COLLECTOR_VERSION, "1.0.7")
  const seed = Array.from({ length: LOCAL_N }, (_, i) => item(asinAt(i), { queueSeq: i + 1 }))
  const extras = Array.from({ length: EXTRA }, (_, i) => item(asinAt(LOCAL_N + i), { queueSeq: LOCAL_N + i + 1 }))
  const pending = [
    ev("10", "B0REMOVED01", {
      eventType: "ASIN_REMOVED",
      payload: { status: "REMOVED", activeConsumerCount: 0, priority: "STANDARD", cadenceHours: 24 },
    }),
    ev("11", asinAt(0), {
      eventType: "SOLD_PRIORITY_CHANGED",
      payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "SOLD", cadenceHours: 12 },
    }),
    ev("12", asinAt(1), {
      eventType: "SOLD_PRIORITY_CHANGED",
      payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "SOLD", cadenceHours: 12 },
    }),
  ]
  const covered = ev("00", asinAt(9), {
    createdAt: "2026-09-21T17:00:00.000Z",
    status: "COVERED_BY_SNAPSHOT",
  })

  const db = openKeepaLocalDb(":memory:")
  seedLocal(db, LOCAL_N)
  for (let i = 0; i < 5; i++) saveSnapshot(db, asinAt(i), `fp${i}`, "{}", 5)
  assert.equal(localReconcileManifest(db).uniqueAsins, 12732)
  assert.equal(snapshotCount(db), 5)
  assert.equal(candidateCount(db), 0)
  const preservedScan = db.prepare("SELECT last_scanned_at AS l, next_scan_at AS n FROM asin_registry WHERE asin = ?").get(asinAt(8)) as {
    l: number
    n: number
  }
  console.log("PASS 1 local 12732 snapshot 5 candidate 0")

  const world = mockWorld(seed, extras, [...pending, covered])
  const afterCatch = await catchUpLifecycleThenReconcile({ db, http: world.http, nowMs })
  assert.equal(afterCatch.pulled, 3)
  assert.equal(afterCatch.reconcileMatched, false)
  assert.equal(localReconcileManifest(db).uniqueAsins, 12732)
  console.log("PASS 2 three pending applied still mismatch")

  const once = await runKeepaCollector({
    env: envMode("once"),
    db,
    skipLock: true,
    http: world.http,
    keepaFetch: async () => {
      world.keepaCalls++
      throw new Error("keepa-must-not-run")
    },
  })
  assert.equal(once.keepaCalls, 0)
  assert.equal(world.keepaCalls, 0)
  assert.equal(getWorkerState(db, "repair_merged"), null)
  const dash = keepaCollectorDashboardFromRow({
    collectorId: "scraper-1",
    hostname: "scraper",
    payload: { lastErrorCode: "SYNC_RECONCILE_MISMATCH", reconcileMatched: false, tokensLeft: 1 },
    collectedAt: new Date().toISOString(),
  })
  assert.equal(dash.registryStatusLabel, "Registry repair gerekli")
  console.log("PASS 3 once Keepa 0 no auto repair")

  const db2 = openKeepaLocalDb(":memory:")
  seedLocal(db2, LOCAL_N)
  for (let i = 0; i < 5; i++) saveSnapshot(db2, asinAt(i), `fp${i}`, "{}", 5)
  const world2 = mockWorld(seed, extras, [...pending, covered])
  const repair = await runCollectorRepair({
    db: db2,
    http: world2.http,
    pageSize: 200,
    nowMs,
    hooks: {
      afterMergeCommit: () => undefined,
    },
  })
  assert.equal(repair.ok, true)
  assert.equal(repair.keepaCalls, 0)
  assert.equal(repair.localCount, 12736)
  assert.equal(localReconcileManifest(db2).hash, repair.localHash)
  assert.equal(snapshotCount(db2), 5)
  assert.equal(candidateCount(db2), 0)
  const kept = db2.prepare("SELECT last_scanned_at AS l, next_scan_at AS n FROM asin_registry WHERE asin = ?").get(asinAt(8)) as {
    l: number
    n: number
  }
  assert.equal(kept.l, preservedScan.l)
  assert.equal(kept.n, preservedScan.n)
  const maxOld = 1_000_000 + (LOCAL_N - 1) * 1000
  for (let i = 0; i < EXTRA; i++) {
    const row = db2.prepare("SELECT next_scan_at AS n FROM asin_registry WHERE asin = ?").get(asinAt(LOCAL_N + i)) as { n: number }
    assert.ok(row.n >= maxOld)
  }
  console.log("PASS 4-9 repair merge 12736 snapshots/candidates/schedule/tail")

  applySyncEvent(
    db2,
    {
      eventId: ev("20", asinAt(2)).eventId as string,
      asin: asinAt(2),
      eventType: "QTY_ZERO_PAUSED",
      sourceVersion: 9,
      payload: { status: "PAUSED_QTY_ZERO", activeConsumerCount: 0, priority: "STANDARD", cadenceHours: 24 },
      nowMs,
    },
    { remoteAckStatus: "ACKED_REMOTE" }
  )
  assert.equal(dueAsins(db2, nowMs + 365 * 86400_000, 10).some(r => r.asin === asinAt(2)), false)
  db2.prepare("UPDATE asin_registry SET last_scanned_at = ?, next_scan_at = ? WHERE asin = ?").run(nowMs, nowMs, asinAt(0))
  assert.equal(dueAsins(db2, nowMs + 11 * 3600_000, 20).some(r => r.asin === asinAt(0)), false)
  assert.equal(dueAsins(db2, nowMs + 12 * 3600_000 + 1, 20).some(r => r.asin === asinAt(0)), true)
  console.log("PASS 10-11 paused not due, SOLD 12h")

  {
    const dbE = openKeepaLocalDb(":memory:")
    seedLocal(dbE, 8)
    const extraItems = [item(asinAt(8)), item(asinAt(9)), item(asinAt(10)), item(asinAt(11))]
    const w = mockWorld(
      Array.from({ length: 8 }, (_, i) => item(asinAt(i))),
      extraItems,
      []
    )
    const mid = ev("30", asinAt(8), { createdAt: "2026-09-22T06:00:01.000Z" })
    const r = await runCollectorRepair({
      db: dbE,
      http: w.http,
      pageSize: 200,
      nowMs,
      hooks: {
        afterMergeCommit: () => w.injectEvent(mid),
      },
    })
    assert.equal(r.ok, true)
    assert.ok(r.applied >= 1 || r.pulled >= 1)
    console.log("PASS 12 snapshot-time event second catch-up")
  }

  {
    const dbC = openKeepaLocalDb(":memory:")
    seedLocal(dbC, 8)
    const w = mockWorld(
      Array.from({ length: 8 }, (_, i) => item(asinAt(i))),
      [item(asinAt(8)), item(asinAt(9)), item(asinAt(10)), item(asinAt(11))],
      []
    )
    try {
      await runCollectorRepair({
        db: dbC,
        http: w.http,
        pageSize: 200,
        nowMs,
        hooks: { beforeMergeCommit: () => { throw new CrashSimError("CRASH_BEFORE_MERGE") } },
      })
      assert.fail("expected crash")
    } catch (e) {
      assert.ok(e instanceof CrashSimError)
    }
    assert.equal(registryCount(dbC), 8)
    assert.equal(bootstrapPhase(dbC), "COMPLETE")
    console.log("PASS 13 crash before merge keeps registry")
  }

  {
    const dbC = openKeepaLocalDb(":memory:")
    seedLocal(dbC, 8)
    const w = mockWorld(
      Array.from({ length: 8 }, (_, i) => item(asinAt(i))),
      [item(asinAt(8)), item(asinAt(9)), item(asinAt(10)), item(asinAt(11))],
      []
    )
    try {
      await runCollectorRepair({
        db: dbC,
        http: w.http,
        pageSize: 200,
        nowMs,
        hooks: { afterMergeCommit: () => { throw new CrashSimError("CRASH_AFTER_MERGE") } },
      })
      assert.fail("expected crash")
    } catch (e) {
      assert.ok(e instanceof CrashSimError)
    }
    assert.equal(registryCount(dbC), 12)
    const resume = await runCollectorRepair({ db: dbC, http: w.http, pageSize: 200, nowMs })
    assert.equal(resume.ok, true)
    assert.equal(w.receipts.length, 1)
    const again = await runCollectorRepair({ db: dbC, http: w.http, pageSize: 200, nowMs })
    assert.equal(again.ok, true)
    assert.equal(w.receipts.length, 1)
    console.log("PASS 14+16 crash after merge idempotent receipt")
  }

  {
    const dbC = openKeepaLocalDb(":memory:")
    seedLocal(dbC, 8)
    const w = mockWorld(
      Array.from({ length: 8 }, (_, i) => item(asinAt(i))),
      [item(asinAt(8)), item(asinAt(9)), item(asinAt(10)), item(asinAt(11))],
      []
    )
    w.force409 = true
    const r = await runCollectorRepair({ db: dbC, http: w.http, pageSize: 200, nowMs })
    assert.equal(r.ok, false)
    assert.equal(r.error, "REPAIR_COMPLETE_409")
    assert.equal(bootstrapPhase(dbC), "COMPLETE")
    assert.equal(w.receipts.length, 0)
    console.log("PASS 15 repair-complete 409 no success receipt")
  }

  assert.equal(world2.keepaCalls, 0)
  assert.equal(world2.coveredMutations, 0)
  const pulledCovered: string[] = []
  const dbCov = openKeepaLocalDb(":memory:")
  seedLocal(dbCov, 8)
  const wCov = mockWorld(
    Array.from({ length: 8 }, (_, i) => item(asinAt(i))),
    [item(asinAt(8))],
    [covered]
  )
  await catchUpLifecycleThenReconcile({
    db: dbCov,
    http: {
      getJson: async pathName => {
        const res = await wCov.http.getJson(pathName)
        if (pathName.includes("/events")) {
          for (const e of ((res.json.events as Array<{ eventId: string }>) ?? [])) pulledCovered.push(e.eventId)
        }
        return res
      },
      postJson: wCov.http.postJson,
    },
    nowMs,
  })
  assert.equal(pulledCovered.includes(String(covered.eventId)), false)
  console.log("PASS 17-19 Keepa 0, covered not pulled, no bulk COVERED")

  {
    const dbA = openKeepaLocalDb(":memory:")
    seedLocal(dbA, 8)
    const w = mockWorld(
      Array.from({ length: 8 }, (_, i) => item(asinAt(i))),
      [item(asinAt(8)), item(asinAt(9)), item(asinAt(10)), item(asinAt(11))],
      [ev("40", asinAt(8))]
    )
    try {
      await runCollectorRepair({
        db: dbA,
        http: w.http,
        pageSize: 200,
        nowMs,
        hooks: { beforeLocalCommit: () => { throw new CrashSimError("CRASH_BEFORE_EVENT_COMMIT") } },
      })
      assert.fail("expected crash")
    } catch (e) {
      assert.ok(e instanceof CrashSimError)
    }
    assert.equal(w.ackCalls, 0)
    console.log("PASS 20 event commit before ACK 0")
  }

  {
    const dbM = openKeepaLocalDb(":memory:")
    seedLocal(dbM, 8)
    const extraItems = [item(asinAt(8)), item(asinAt(9)), item(asinAt(10)), item(asinAt(11))]
    const w = mockWorld(Array.from({ length: 8 }, (_, i) => item(asinAt(i))), extraItems, [])
    const repaired = await runCollectorRepair({ db: dbM, http: w.http, pageSize: 200, nowMs })
    assert.equal(repaired.ok, true)
    w.injectEvent(
      ev("50", asinAt(8), {
        createdAt: "2026-09-22T07:00:00.000Z",
        eventType: "SOLD_PRIORITY_CHANGED",
        payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "SOLD", cadenceHours: 12 },
      })
    )
    const sync = await catchUpLifecycleThenReconcile({ db: dbM, http: w.http, nowMs: nowMs + 3600_000 })
    assert.equal(sync.reconcileMatched, true)
    assert.equal(getWorkerState(dbM, "repair_merged"), "1")
    console.log("PASS 21 future event catch-up matches without new full repair")
  }

  const joined = JSON.stringify(world2.payloads)
  assert.equal(/B0[0-9]{8}/.test(joined), false)
  for (const p of world2.payloads) assert.equal(telemetryContainsForbidden(p), false)
  const okDash = keepaCollectorDashboardFromRow({
    collectorId: "scraper-1",
    hostname: "scraper",
    payload: { reconcileMatched: true, tokensLeft: 9 },
    collectedAt: new Date().toISOString(),
  })
  assert.equal(okDash.registryStatusLabel, "Registry eşleşiyor")
  assert.equal(keepaDirectMutationsEnabled(), false)
  const invalid = loadKeepaCollectorConfig({ KEEPA_COLLECTOR_RUN_MODE: "" })
  assert.equal(invalid.runMode, null)
  assert.equal(loadKeepaCollectorConfig({ KEEPA_COLLECTOR_RUN_MODE: "repair-only" }).runMode, "repair-only")
  console.log("PASS 22 telemetry/dashboard no ASIN, repair-only mode explicit")

  console.log("PASS keepa-collector 1.0.7 fixtures")
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})
