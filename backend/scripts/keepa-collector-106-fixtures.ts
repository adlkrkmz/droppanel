import assert from "assert"
import { tmpdir } from "os"
import { join } from "path"
import {
  applySyncEvent,
  candidateCount,
  dueAsins,
  keepaScanAllowed,
  localReconcileManifest,
  openKeepaLocalDb,
  pendingAckCount,
  registryCount,
  saveSnapshot,
  setWorkerState,
  snapshotCount,
} from "../modules/keepaSensor/keepaLocalDb"
import { CrashSimError, type CollectorHttp } from "../modules/keepaSensor/keepaCollectorBootstrap"
import { catchUpLifecycleThenReconcile } from "../modules/keepaSensor/keepaCollectorEventSync"
import { computeKeepaReconcileManifest } from "../modules/keepaSensor/keepaCollectorReconcile"
import { keepaDirectMutationsEnabled } from "../modules/keepaSensor/keepaDirectMutationGate"
import {
  buildCollectorTelemetryPayload,
  loadKeepaCollectorConfig,
  runKeepaCollector,
  runKeepaCollectorOnceBatches,
  scanDueAsins,
} from "../modules/keepaSensor/keepaCollectorLoop"
import { sanitizeKeepaCollectorTelemetry, telemetryContainsForbidden } from "../modules/keepaSensor/keepaCollectorTelemetry"
import { KEEPA_COLLECTOR_VERSION } from "../modules/keepaSensor/keepaCollectorVersion"
import type { SnapshotItem } from "../modules/keepaSensor/keepaLocalDb"

const t0 = "2026-09-21T18:05:08.146Z"
const tLate = "2026-09-21T18:06:00.000Z"
const tNewer = "2026-09-21T18:06:30.000Z"
const nowMs = Date.parse("2026-09-21T18:10:00.000Z")

function asinAt(i: number): string {
  return `B0${String(10000000 + i).slice(-8)}`
}

function item(asin: string, extra: Partial<SnapshotItem> = {}): SnapshotItem {
  return {
    asin,
    activeConsumerCount: 1,
    status: "ACTIVE",
    priority: "STANDARD",
    cadenceHours: 24,
    sourceVersion: 1,
    queueSeq: extra.queueSeq ?? 1,
    ...extra,
  }
}

function seedComplete(db: ReturnType<typeof openKeepaLocalDb>, rows: SnapshotItem[]) {
  for (const [i, row] of rows.entries()) {
    applySyncEvent(
      db,
      {
        eventId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        asin: row.asin,
        eventType: "ASIN_UPSERT",
        sourceVersion: row.sourceVersion,
        payload: {
          status: row.status,
          activeConsumerCount: row.activeConsumerCount,
          priority: row.priority,
          cadenceHours: row.cadenceHours,
        },
        nowMs: 1_000_000 + i,
      },
      { remoteAckStatus: "ACKED_REMOTE" }
    )
  }
  setWorkerState(db, "bootstrap_status", "COMPLETE")
  setWorkerState(db, "bootstrap_phase", "COMPLETE")
  setWorkerState(db, "snapshot_started_at", t0)
  const local = localReconcileManifest(db)
  setWorkerState(db, "central_reconcile_hash", local.hash)
  setWorkerState(db, "central_reconcile_count", String(local.uniqueAsins))
}

function ev(idTail: string, asin: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa${idTail}`,
    asin,
    eventType: extra.eventType ?? "ASIN_UPSERT",
    sourceVersion: extra.sourceVersion ?? 1,
    createdAt: extra.createdAt ?? tLate,
    status: extra.status ?? "PENDING",
    payload:
      extra.payload ??
      { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
    ...extra,
  }
}

function projected(seed: SnapshotItem[], events: Record<string, unknown>[]): SnapshotItem[] {
  const map = new Map<string, SnapshotItem>()
  for (const row of seed) {
    if (row.status === "ACTIVE" || row.status === "PAUSED_QTY_ZERO") map.set(row.asin, { ...row })
  }
  const ordered = [...events]
    .filter(e => e.status !== "COVERED_BY_SNAPSHOT")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  for (const row of ordered) {
    const asin = String(row.asin ?? "")
    const eventType = String(row.eventType ?? "")
    const payload = (row.payload ?? {}) as Record<string, unknown>
    if (eventType === "ASIN_REMOVED" || String(payload.status ?? "") === "REMOVED") {
      map.delete(asin)
      continue
    }
    const prev = map.get(asin)
    if (prev && Number(row.sourceVersion ?? 0) <= prev.sourceVersion) continue
    let status = String(payload.status ?? prev?.status ?? "ACTIVE")
    let priority = String(payload.priority ?? prev?.priority ?? "STANDARD")
    let cadenceHours = Number(payload.cadenceHours ?? prev?.cadenceHours ?? 24)
    if (eventType === "QTY_ZERO_PAUSED") status = "PAUSED_QTY_ZERO"
    if (eventType === "SOLD_PRIORITY_CHANGED") {
      priority = "SOLD"
      cadenceHours = 12
    }
    map.set(asin, {
      asin,
      activeConsumerCount: Number(payload.activeConsumerCount ?? prev?.activeConsumerCount ?? 0),
      status,
      priority,
      cadenceHours,
      sourceVersion: Number(row.sourceVersion ?? prev?.sourceVersion ?? 0),
      queueSeq: prev?.queueSeq ?? map.size,
    })
  }
  return [...map.values()]
}

type MockCtl = {
  http: CollectorHttp
  ackCalls: number
  heartbeatPosts: number
  payloads: Record<string, unknown>[]
  events: Record<string, unknown>[]
  remotePending: Set<string>
  remoteAcked: Set<string>
  forceMismatch: boolean
  ackStatusFor: (id: string) => number
  setAckStatus: (id: string, status: number) => void
  injectEvent: (row: Record<string, unknown>) => void
}

function mockWorld(seed: SnapshotItem[], initialEvents: Record<string, unknown>[] = []): MockCtl {
  const events = [...initialEvents]
  const remotePending = new Set(events.filter(e => e.status !== "COVERED_BY_SNAPSHOT").map(e => String(e.eventId)))
  const remoteAcked = new Set<string>()
  const ackStatus = new Map<string, number>()
  const ctl: MockCtl = {
    ackCalls: 0,
    heartbeatPosts: 0,
    payloads: [],
    events,
    remotePending,
    remoteAcked,
    forceMismatch: false,
    ackStatusFor: id => ackStatus.get(id) ?? 200,
    setAckStatus: (id, status) => ackStatus.set(id, status),
    injectEvent: row => {
      events.push(row)
      remotePending.add(String(row.eventId))
    },
    http: {
      async getJson(pathName: string) {
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
          if (ctl.forceMismatch) {
            return { status: 200, json: { ok: true, hash: "0".repeat(64), count: 999 } }
          }
          const manifest = computeKeepaReconcileManifest(projected(seed, events))
          return {
            status: 200,
            json: { ok: true, hash: manifest.hash, count: manifest.uniqueAsins },
          }
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
            const st = ctl.ackStatusFor(id)
            if (st !== 200) return { status: st, json: { ok: false } }
            if (remoteAcked.has(id)) alreadyAcked++
            else {
              remotePending.delete(id)
              remoteAcked.add(id)
              acked++
            }
          }
          return { status: 200, json: { ok: true, acked, alreadyAcked } }
        }
        return { status: 404, json: {} }
      },
    },
  }
  return ctl
}

function envOnce(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    KEEPA_COLLECTOR_ENABLED: "true",
    KEEPA_ENABLED: "true",
    KEEPA_COLLECTOR_RUN_MODE: "once",
    KEEPA_COLLECTOR_MAX_BATCHES: "1",
    KEEPA_COLLECTOR_BATCH_SIZE: "100",
    LISTJETGO_API_BASE: "http://local",
    KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
    KEEPA_API_KEY: "k",
    KEEPA_TOKEN_RESERVE: "5",
    ...extra,
  }
}

function keepaOk(asins: string[]): {
  ok: true
  status: number
  durationMs: number
  body: { tokensLeft: number; tokensConsumed: number; products: Array<{ asin: string; stats: { current: number[] } }> }
} {
  return {
    ok: true,
    status: 200,
    durationMs: 1,
    body: {
      tokensLeft: 1190,
      tokensConsumed: asins.length,
      products: asins.map(asin => ({ asin, stats: { current: Array(40).fill(-1) } })),
    },
  }
}

async function main(): Promise<void> {
  console.log("106 start")
  assert.equal(KEEPA_COLLECTOR_VERSION, "1.0.7")
  const seed = Array.from({ length: 100 }, (_, i) => item(asinAt(i), { queueSeq: i + 1 }))
  const four = [0, 1, 2, 3].map(i => ev(String(10 + i), asinAt(100 + i)))

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, seed)
    for (let i = 0; i < 5; i++) saveSnapshot(db, seed[i].asin, `fp${i}`, "{}", 1)
    assert.equal(localReconcileManifest(db).uniqueAsins, 100)
    const world = mockWorld(seed, four)
    let keepaBefore = 0
    const sync = await catchUpLifecycleThenReconcile({
      db,
      http: {
        getJson: async pathName => {
          assert.equal(keepaBefore, 0)
          return world.http.getJson(pathName)
        },
        postJson: world.http.postJson,
      },
      nowMs,
    })
    assert.equal(sync.pulled, 4)
    assert.equal(sync.applied, 4)
    assert.equal(sync.acked, 4)
    assert.equal(sync.reconcileMatched, true)
    assert.equal(sync.localCount, 104)
    assert.equal(sync.centralCount, 104)
    assert.equal(pendingAckCount(db), 0)
    assert.equal(keepaScanAllowed(db).allowed, true)
    assert.equal(snapshotCount(db), 5)
    assert.equal(candidateCount(db), 0)
    console.log("PASS 1-4 catch-up four events then reconcile 104")

    const cfg = loadKeepaCollectorConfig(envOnce())
    let keepaCalls = 0
    const scan = await runKeepaCollectorOnceBatches(cfg, db, {
      keepaFetch: async input => {
        keepaCalls++
        return keepaOk(input.asins)
      },
      http: world.http,
    })
    assert.equal(scan.keepaCalls, 1)
    assert.equal(keepaCalls, 1)
    console.log("PASS 5 catch-up Keepa 0 then one Keepa batch")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, seed)
    const world = mockWorld(seed, four)
    try {
      await catchUpLifecycleThenReconcile({
        db,
        http: world.http,
        nowMs,
        hooks: { beforeLocalCommit: () => { throw new CrashSimError("CRASH_BEFORE_COMMIT") } },
      })
      assert.fail("expected crash")
    } catch (e) {
      assert.ok(e instanceof CrashSimError)
    }
    assert.equal(world.ackCalls, 0)
    assert.equal(pendingAckCount(db), 0)
    assert.equal(registryCount(db), 100)
    console.log("PASS 6 crash before local commit ACK 0")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, seed)
    const world = mockWorld(seed, four)
    try {
      await catchUpLifecycleThenReconcile({
        db,
        http: world.http,
        nowMs,
        hooks: { afterLocalCommit: () => { throw new CrashSimError("CRASH_AFTER_COMMIT") } },
      })
      assert.fail("expected crash")
    } catch (e) {
      assert.ok(e instanceof CrashSimError)
    }
    assert.equal(world.ackCalls, 0)
    assert.equal(pendingAckCount(db), 4)
    const resume = await catchUpLifecycleThenReconcile({ db, http: world.http, nowMs })
    assert.equal(resume.acked, 4)
    assert.equal(resume.applied, 0)
    assert.equal(resume.reconcileMatched, true)
    assert.equal(pendingAckCount(db), 0)
    console.log("PASS 7 commit then crash resume ACK no duplicate state")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, seed)
    const world = mockWorld(seed, four)
    try {
      await catchUpLifecycleThenReconcile({
        db,
        http: world.http,
        nowMs,
        hooks: { beforeMarkAckedRemote: () => { throw new CrashSimError("CRASH_AFTER_ACK_HTTP") } },
      })
      assert.fail("expected crash")
    } catch (e) {
      assert.ok(e instanceof CrashSimError)
    }
    assert.ok(world.ackCalls >= 1)
    assert.ok(pendingAckCount(db) > 0)
    const resume = await catchUpLifecycleThenReconcile({ db, http: world.http, nowMs })
    assert.equal(resume.reconcileMatched, true)
    assert.equal(pendingAckCount(db), 0)
    console.log("PASS 8 ACK HTTP then crash already-acked safe")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, seed)
    const world = mockWorld(seed, four)
    let ackedMark = 0
    try {
      await catchUpLifecycleThenReconcile({
        db,
        http: world.http,
        nowMs,
        hooks: {
          beforeMarkAckedRemote: () => {
            ackedMark++
            if (ackedMark === 4) throw new CrashSimError("CRASH_ON_FOURTH_ACK")
          },
        },
      })
      assert.fail("expected crash")
    } catch (e) {
      assert.ok(e instanceof CrashSimError)
    }
    assert.equal(pendingAckCount(db), 1)
    const resume = await catchUpLifecycleThenReconcile({ db, http: world.http, nowMs })
    assert.equal(resume.acked, 1)
    assert.equal(pendingAckCount(db), 0)
    assert.equal(resume.reconcileMatched, true)
    console.log("PASS 9 3/4 ACK then resume")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, seed)
    const dup = ev("20", asinAt(100))
    applySyncEvent(
      db,
      {
        eventId: String(dup.eventId),
        asin: asinAt(100),
        eventType: "ASIN_UPSERT",
        sourceVersion: 1,
        payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
        nowMs,
      },
      { remoteAckStatus: "ACKED_REMOTE" }
    )
    const world = mockWorld([...seed, item(asinAt(100))], [dup])
    const sync = await catchUpLifecycleThenReconcile({ db, http: world.http, nowMs })
    assert.equal(sync.applied, 0)
    assert.equal(sync.noop, 1)
    assert.equal(sync.reconcileMatched, true)
    console.log("PASS 10 duplicate event no-op")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    const row = item(asinAt(0), { sourceVersion: 2 })
    seedComplete(db, [row])
    const older = ev("21", asinAt(0), {
      sourceVersion: 1,
      payload: { status: "PAUSED_QTY_ZERO", activeConsumerCount: 0, priority: "STANDARD", cadenceHours: 24 },
    })
    const world = mockWorld([row], [older])
    await catchUpLifecycleThenReconcile({ db, http: world.http, nowMs })
    const cur = db.prepare("SELECT status AS s, source_version AS v FROM asin_registry WHERE asin = ?").get(asinAt(0)) as {
      s: string
      v: number
    }
    assert.equal(cur.s, "ACTIVE")
    assert.equal(cur.v, 2)
    console.log("PASS 11 sourceVersion does not regress")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    const rows = [item(asinAt(0)), item(asinAt(1))]
    seedComplete(db, rows)
    const world = mockWorld(rows, [
      ev("22", asinAt(0), {
        eventType: "QTY_ZERO_PAUSED",
        sourceVersion: 2,
        payload: { status: "PAUSED_QTY_ZERO", activeConsumerCount: 0, priority: "STANDARD", cadenceHours: 24 },
      }),
      ev("23", asinAt(1), {
        eventType: "ASIN_REMOVED",
        sourceVersion: 2,
        payload: { status: "REMOVED", activeConsumerCount: 0, priority: "STANDARD", cadenceHours: 24 },
      }),
    ])
    await catchUpLifecycleThenReconcile({ db, http: world.http, nowMs })
    const due = dueAsins(db, nowMs + 365 * 86400_000, 100)
    assert.equal(due.some(r => r.asin === asinAt(0) || r.asin === asinAt(1)), false)
    console.log("PASS 12 QTY_ZERO/REMOVED leave due")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    const rows = [item(asinAt(0)), item(asinAt(1))]
    seedComplete(db, rows)
    db.prepare("UPDATE asin_registry SET last_scanned_at = ?, next_scan_at = ?").run(nowMs, nowMs)
    const world = mockWorld(rows, [
      ev("24", asinAt(0), {
        eventType: "SOLD_PRIORITY_CHANGED",
        sourceVersion: 2,
        payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "SOLD", cadenceHours: 12 },
      }),
    ])
    await catchUpLifecycleThenReconcile({ db, http: world.http, nowMs })
    const soon = dueAsins(db, nowMs + 11 * 3600_000, 10).map(r => r.asin)
    const soldDue = dueAsins(db, nowMs + 12 * 3600_000 + 1, 10).map(r => r.asin)
    const stdDue = dueAsins(db, nowMs + 24 * 3600_000 + 1, 10).map(r => r.asin)
    assert.equal(soon.includes(asinAt(0)), false)
    assert.equal(soldDue.includes(asinAt(0)), true)
    assert.equal(stdDue.includes(asinAt(1)), true)
    assert.equal(dueAsins(db, nowMs + 23 * 3600_000, 10).some(r => r.asin === asinAt(1)), false)
    console.log("PASS 13 SOLD 12h STANDARD 24h")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, seed)
    const world = mockWorld(seed, [four[0]])
    const sync = await catchUpLifecycleThenReconcile({
      db,
      http: world.http,
      nowMs,
      catchUpMaxRounds: 8,
      hooks: {
        afterLocalCommit: () => {
          if (world.events.length === 1) world.injectEvent(four[1])
        },
      },
    })
    assert.ok(sync.catchupRound >= 2)
    assert.equal(sync.applied, 2)
    assert.equal(sync.reconcileMatched, true)
    console.log("PASS 14 new event during catch-up second round")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, seed)
    const world = mockWorld(seed, [four[0]])
    const sync = await catchUpLifecycleThenReconcile({
      db,
      http: world.http,
      nowMs,
      catchUpMaxRounds: 1,
      hooks: {
        afterLocalCommit: () => world.injectEvent(four[1]),
      },
    })
    assert.equal(sync.error, "CATCHUP_LIMIT_EXCEEDED")
    assert.equal(sync.keepaAllowed, false)
    const cfg = loadKeepaCollectorConfig(envOnce())
    let keepaCalls = 0
    const scan = await scanDueAsins(cfg, db, {
      nowMs,
      keepaFetch: async input => {
        keepaCalls++
        return keepaOk(input.asins)
      },
    })
    assert.equal(keepaCalls, 0)
    assert.equal(scan.keepaCalls, 0)
    console.log("PASS 15 catch-up limit Keepa 0")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, seed)
    const world = mockWorld(seed, four)
    world.forceMismatch = true
    const sync = await catchUpLifecycleThenReconcile({ db, http: world.http, nowMs })
    assert.equal(sync.error, "SYNC_RECONCILE_MISMATCH")
    assert.equal(sync.keepaAllowed, false)
    const cfg = loadKeepaCollectorConfig(envOnce())
    const scan = await scanDueAsins(cfg, db, { nowMs, keepaFetch: async () => { throw new Error("keepa") } })
    assert.equal(scan.keepaCalls, 0)
    assert.equal(candidateCount(db), 0)
    console.log("PASS 16 catch-up mismatch Keepa 0")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, seed)
    applySyncEvent(
      db,
      {
        eventId: ev("30", asinAt(0)).eventId as string,
        asin: asinAt(0),
        eventType: "ASIN_UPSERT",
        sourceVersion: 9,
        payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
        nowMs,
      },
      { remoteAckStatus: "PENDING_ACK" }
    )
    assert.ok(pendingAckCount(db) > 0)
    const cfg = loadKeepaCollectorConfig(envOnce())
    const scan = await scanDueAsins(cfg, db, { nowMs, keepaFetch: async () => { throw new Error("keepa") } })
    assert.equal(scan.keepaCalls, 0)
    assert.equal(scan.skipped, "PENDING_ACK")
    console.log("PASS 17 PENDING_ACK>0 Keepa 0")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, seed)
    const covered = ev("31", asinAt(50), { createdAt: "2026-09-21T18:00:00.000Z", status: "COVERED_BY_SNAPSHOT" })
    const world = mockWorld(seed, [covered, four[0]])
    const pulled: string[] = []
    const sync = await catchUpLifecycleThenReconcile({
      db,
      http: {
        getJson: async pathName => {
          const res = await world.http.getJson(pathName)
          if (pathName.includes("/events")) {
            const list = (res.json.events as Array<{ eventId: string }>) ?? []
            for (const e of list) pulled.push(e.eventId)
          }
          return res
        },
        postJson: world.http.postJson,
      },
      nowMs,
    })
    assert.equal(pulled.includes(String(covered.eventId)), false)
    assert.equal(sync.applied, 1)
    console.log("PASS 18 COVERED rows not pulled")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, seed)
    for (let i = 0; i < 5; i++) saveSnapshot(db, seed[i].asin, `keep${i}`, "{}", 5)
    const world = mockWorld(seed, four)
    await catchUpLifecycleThenReconcile({ db, http: world.http, nowMs })
    assert.equal(snapshotCount(db), 5)
    assert.equal(candidateCount(db), 0)
    console.log("PASS 19 snapshot 5 candidate 0 preserved")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, [item(asinAt(0))])
    const world = mockWorld([item(asinAt(0))])
    const cfg = loadKeepaCollectorConfig(envOnce())
    const scan = await scanDueAsins(cfg, db, {
      nowMs,
      keepaFetch: async input => ({
        ok: true,
        status: 200,
        durationMs: 1,
        body: { tokensLeft: 10, tokensConsumed: input.asins.length + 1, products: [] },
      }),
    })
    assert.equal(scan.skipped, "TOKEN_COST_EXCEEDED")
    assert.equal(scan.stopKeepa, true)
    console.log("PASS 20 tokensConsumed>requested fail-closed")
  }

  {
    const db = openKeepaLocalDb(":memory:")
    seedComplete(db, seed)
    const world = mockWorld(seed, four)
    const cfg = loadKeepaCollectorConfig(envOnce())
    let keepaCalls = 0
    const run = await runKeepaCollector({
      env: envOnce(),
      db,
      skipLock: true,
      http: world.http,
      keepaFetch: async input => {
        keepaCalls++
        return keepaOk(input.asins)
      },
    })
    assert.ok(world.heartbeatPosts >= 2)
    assert.equal(run.keepaCalls, keepaCalls)
    assert.ok(keepaCalls >= 1)
    const joined = JSON.stringify(world.payloads)
    assert.equal(joined.includes("keepa_api_key"), false)
    assert.equal(/B0[0-9]{8}/.test(joined), false)
    for (const p of world.payloads) {
      assert.equal(telemetryContainsForbidden(p), false)
    }
    void cfg
    console.log("PASS 21-22 startup/final telemetry no secret/ASIN")
  }

  {
    const bootOnly = await runKeepaCollector({
      env: {
        KEEPA_COLLECTOR_ENABLED: "true",
        KEEPA_COLLECTOR_RUN_MODE: "bootstrap-only",
        LISTJETGO_API_BASE: "http://local",
        KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
        KEEPA_ENABLED: "true",
        KEEPA_API_KEY: "dummy-keepa-key-xx",
        KEEPA_LOCAL_DB_PATH: join(tmpdir(), `kc-106-boot-${Date.now()}.sqlite`),
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
    const invalid = loadKeepaCollectorConfig({ KEEPA_COLLECTOR_RUN_MODE: "" })
    assert.equal(invalid.runMode, null)
    const daemon = loadKeepaCollectorConfig({ KEEPA_COLLECTOR_RUN_MODE: "daemon" })
    assert.equal(daemon.runMode, "daemon")
    assert.equal(keepaDirectMutationsEnabled(), false)
    const dirty = sanitizeKeepaCollectorTelemetry({
      collectorVersion: "1.0.6",
      asin: "B0SECRETS01",
      keepaApiKey: "abc",
      tokensLeft: 9,
      syncState: "SYNCING_EVENTS",
    } as Record<string, unknown>)
    assert.equal("asin" in dirty, false)
    const dbTel = openKeepaLocalDb(":memory:")
    seedComplete(dbTel, [item(asinAt(0))])
    const payload = buildCollectorTelemetryPayload(loadKeepaCollectorConfig(envOnce()), dbTel, { syncState: "SYNCING_EVENTS" })
    assert.equal(payload.syncState, "SYNCING_EVENTS")
    assert.equal(JSON.stringify(payload).includes(asinAt(0)), false)
    console.log("PASS 23 bootstrap-only/once/daemon regression gate")
  }

  console.log("PASS keepa-collector 1.0.6 fixtures")
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
