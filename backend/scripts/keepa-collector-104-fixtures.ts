import assert from "assert"
import { tmpdir } from "os"
import {
  applySyncEvent,
  bootstrapPhase,
  keepaScanAllowed,
  localReconcileManifest,
  openKeepaLocalDb,
  pendingAckCount,
  registryCount,
  setWorkerState,
  type SnapshotItem,
} from "../modules/keepaSensor/keepaLocalDb"
import {
  CrashSimError,
  runCollectorBootstrap,
  type CollectorHttp,
} from "../modules/keepaSensor/keepaCollectorBootstrap"
import { computeKeepaReconcileManifest } from "../modules/keepaSensor/keepaCollectorReconcile"
import { shouldMarkCoveredBySnapshot } from "../modules/keepaSensor/keepaCollectorCovered"
import {
  loadKeepaCollectorConfig,
  runKeepaCollector,
  runKeepaCollectorOnceBatches,
} from "../modules/keepaSensor/keepaCollectorLoop"

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

function asinAt(i: number): string {
  return `B0${String(10000000 + i).slice(-8)}`
}

function projectedAfterEvents(pages: SnapshotItem[][], events: Record<string, unknown>[]): SnapshotItem[] {
  const map = new Map<string, SnapshotItem>()
  for (const row of pages.flat()) {
    if (row.status === "ACTIVE" || row.status === "PAUSED_QTY_ZERO") map.set(row.asin, { ...row })
  }
  const ordered = [...events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  for (const ev of ordered) {
    const asin = String(ev.asin ?? "")
    const eventType = String(ev.eventType ?? "")
    const payload = (ev.payload ?? {}) as Record<string, unknown>
    if (eventType === "ASIN_REMOVED" || String(payload.status ?? "") === "REMOVED") {
      map.delete(asin)
      continue
    }
    const prev = map.get(asin)
    map.set(asin, {
      asin,
      activeConsumerCount: Number(payload.activeConsumerCount ?? prev?.activeConsumerCount ?? 0),
      status: String(payload.status ?? prev?.status ?? "ACTIVE"),
      priority: String(payload.priority ?? prev?.priority ?? "STANDARD"),
      cadenceHours: Number(payload.cadenceHours ?? prev?.cadenceHours ?? 24),
      sourceVersion: Number(ev.sourceVersion ?? prev?.sourceVersion ?? 0),
      queueSeq: prev?.queueSeq ?? map.size,
    })
  }
  return [...map.values()]
}

type MockCtl = {
  http: CollectorHttp
  ackCalls: number
  keepaCalls: number
  events: Record<string, unknown>[]
  remotePending: Set<string>
  remoteAcked: Set<string>
  covered: string[]
  ackStatusFor: (id: string) => number
  setAckStatus: (id: string, status: number) => void
  defaultAckStatus: number
  injectEvent: (ev: Record<string, unknown>) => void
}

function mockWorld(pages: SnapshotItem[][], initialEvents: Record<string, unknown>[] = []): MockCtl {
  const events = [...initialEvents]
  const remotePending = new Set(events.map(e => String(e.eventId)))
  const remoteAcked = new Set<string>()
  const covered: string[] = []
  const ackStatus = new Map<string, number>()
  const ctl: MockCtl = {
    ackCalls: 0,
    keepaCalls: 0,
    events,
    remotePending,
    remoteAcked,
    covered,
    defaultAckStatus: 200,
    ackStatusFor: id => ackStatus.get(id) ?? ctl.defaultAckStatus,
    setAckStatus: (id, status) => ackStatus.set(id, status),
    injectEvent: ev => {
      events.push(ev)
      remotePending.add(String(ev.eventId))
    },
    http: {
      async getJson(pathName: string) {
        if (pathName.startsWith("/internal/keepa-collector/snapshot")) {
          const url = new URL(pathName, "http://local")
          const cursor = url.searchParams.get("cursor") ?? ""
          const pageIdx = cursor ? pages.findIndex(p => p[p.length - 1]?.asin === cursor) + 1 : 0
          const page = pages[pageIdx] ?? []
          return {
            status: 200,
            json: {
              ok: true,
              items: page,
              nextCursor: pageIdx + 1 < pages.length ? page[page.length - 1].asin : null,
              offsetSeq: page.length,
              watermark: pageIdx === 0 && !cursor ? { snapshotStartedAt: "2026-09-21T12:00:00.000Z" } : undefined,
            },
          }
        }
        if (pathName.startsWith("/internal/keepa-collector/events")) {
          const url = new URL(pathName, "http://local")
          const since = url.searchParams.get("sinceCreatedAt") ?? ""
          const after = url.searchParams.get("afterEventId") ?? ""
          let list = events.filter(e => String(e.createdAt) >= since)
          if (after) {
            const idx = list.findIndex(e => e.eventId === after)
            list = idx >= 0 ? list.slice(idx + 1) : list
          }
          return { status: 200, json: { ok: true, events: list.slice(0, 100) } }
        }
        if (pathName === "/internal/keepa-collector/reconcile") {
          const manifest = computeKeepaReconcileManifest(projectedAfterEvents(pages, events))
          const last = [...events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[events.length - 1]
          return {
            status: 200,
            json: {
              ok: true,
              hash: manifest.hash,
              count: manifest.uniqueAsins,
              active: manifest.active,
              pausedQtyZero: manifest.pausedQtyZero,
              sold: manifest.sold,
              standard: manifest.standard,
              duplicates: 0,
              sourceVersionRegressions: 0,
              eventHighWatermarkCreatedAt: last ? String(last.createdAt) : "2026-09-21T12:00:00.000Z",
              eventHighWatermarkId: last ? String(last.eventId) : null,
              generatedAt: "2026-09-21T12:00:10.000Z",
            },
          }
        }
        return { status: 404, json: {} }
      },
      async postJson(pathName: string, body?: Record<string, unknown>) {
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
        if (pathName === "/internal/keepa-collector/bootstrap-complete") {
          const wm = String(body?.snapshotStartedAt ?? "")
          for (const ev of events) {
            if (String(ev.createdAt) < wm && remotePending.has(String(ev.eventId))) {
              covered.push(String(ev.eventId))
            }
          }
          return { status: 200, json: { ok: true, covered: covered.length } }
        }
        return { status: 404, json: {} }
      },
    },
  }
  return ctl
}

const t0 = "2026-09-21T12:00:00.000Z"
const tMid = "2026-09-21T12:00:05.000Z"
const tLate = "2026-09-21T12:00:20.000Z"
const base = [item("B0KSSNAP01", { queueSeq: 1 }), item("B0KSSNAP02", { queueSeq: 2 })]

function ev(idTail: string, asin: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa${idTail}`,
    asin,
    eventType: "ASIN_UPSERT",
    sourceVersion: extra.sourceVersion ?? 1,
    createdAt: extra.createdAt ?? tMid,
    payload: extra.payload ?? { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
    ...extra,
  }
}

const scanCfg = loadKeepaCollectorConfig({
  KEEPA_COLLECTOR_ENABLED: "true",
  KEEPA_ENABLED: "true",
  KEEPA_COLLECTOR_RUN_MODE: "once",
  KEEPA_COLLECTOR_MAX_BATCHES: "1",
  KEEPA_COLLECTOR_BATCH_SIZE: "5",
  LISTJETGO_API_BASE: "http://local",
  KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
  KEEPA_API_KEY: "k",
})

async function main(): Promise<void> {
  const e1 = ev("1", "B0KSSNAP03")
  const world1 = mockWorld([base], [e1])
  const db1 = openKeepaLocalDb(":memory:")
  const boot1 = await runCollectorBootstrap({
    db: db1,
    http: world1.http,
    pageSize: 10,
    nowMs: Date.parse(t0),
    hooks: { afterEventPull: () => { throw new CrashSimError("CRASH_AFTER_PULL") } },
  })
  assert.equal(boot1.ok, false)
  assert.equal(registryCount(db1), 0)
  assert.equal(world1.ackCalls, 0)
  assert.equal(world1.remotePending.has(String(e1.eventId)), true)
  console.log("PASS C1 pull-then-crash remote PENDING ackCalls=", world1.ackCalls, "keepa=0")

  const world2 = mockWorld([base], [e1])
  const db2 = openKeepaLocalDb(":memory:")
  const boot2 = await runCollectorBootstrap({
    db: db2,
    http: world2.http,
    pageSize: 10,
    nowMs: Date.parse(t0),
    hooks: { afterStagingApply: () => { throw new CrashSimError("CRASH_AFTER_STAGING") } },
  })
  assert.equal(boot2.ok, false)
  assert.equal(registryCount(db2), 0)
  assert.equal(world2.ackCalls, 0)
  console.log("PASS C2 staging-then-crash ackCalls=", world2.ackCalls, "keepa=0")

  const world3 = mockWorld([base], [e1])
  const db3 = openKeepaLocalDb(":memory:")
  const boot3a = await runCollectorBootstrap({
    db: db3,
    http: world3.http,
    pageSize: 10,
    nowMs: Date.parse(t0),
    hooks: { afterLocalCommit: () => { throw new CrashSimError("CRASH_AFTER_COMMIT") } },
  })
  assert.equal(boot3a.ok, false)
  assert.equal(bootstrapPhase(db3), "COMMITTED_PENDING_ACK")
  assert.ok(pendingAckCount(db3) >= 1)
  assert.equal(world3.ackCalls, 0)
  const boot3b = await runCollectorBootstrap({ db: db3, http: world3.http, pageSize: 10, nowMs: Date.parse(t0) })
  assert.equal(boot3b.ok, true)
  assert.equal(pendingAckCount(db3), 0)
  assert.ok(world3.ackCalls >= 1)
  console.log("PASS C3 commit-then-crash resume ACK ackCalls=", world3.ackCalls, "keepa=0")

  const world4 = mockWorld([base], [e1])
  const db4 = openKeepaLocalDb(":memory:")
  const boot4a = await runCollectorBootstrap({
    db: db4,
    http: world4.http,
    pageSize: 10,
    nowMs: Date.parse(t0),
    hooks: {
      beforeMarkAckedRemote: () => {
        throw new CrashSimError("CRASH_AFTER_ACK_HTTP")
      },
    },
  })
  assert.equal(boot4a.ok, false)
  assert.equal(world4.remoteAcked.has(String(e1.eventId)), true)
  assert.ok(pendingAckCount(db4) >= 1)
  const before = world4.ackCalls
  const boot4b = await runCollectorBootstrap({ db: db4, http: world4.http, pageSize: 10, nowMs: Date.parse(t0) })
  assert.equal(boot4b.ok, true)
  assert.ok(world4.ackCalls > before)
  assert.equal(pendingAckCount(db4), 0)
  console.log("PASS C4 ack-http-then-crash already-acked ackCalls=", world4.ackCalls, "keepa=0")

  const five = [ev("1", "B0KSSNAP03"), ev("2", "B0KEVENT02"), ev("3", "B0KEVENT03"), ev("4", "B0KEVENT04"), ev("5", "B0KEVENT05")]
  const world5 = mockWorld([base], five)
  const db5 = openKeepaLocalDb(":memory:")
  let ackedN = 0
  const boot5a = await runCollectorBootstrap({
    db: db5,
    http: world5.http,
    pageSize: 10,
    nowMs: Date.parse(t0),
    hooks: {
      beforeMarkAckedRemote: () => {
        ackedN++
        if (ackedN === 4) throw new CrashSimError("CRASH_PARTIAL_ACK")
      },
    },
  })
  assert.equal(boot5a.ok, false)
  assert.equal(pendingAckCount(db5), 2)
  const boot5b = await runCollectorBootstrap({ db: db5, http: world5.http, pageSize: 10, nowMs: Date.parse(t0) })
  assert.equal(boot5b.ok, true)
  assert.equal(pendingAckCount(db5), 0)
  console.log("PASS C5 partial 3/5 then resume ackCalls=", world5.ackCalls, "keepa=0")

  const world6 = mockWorld([base], [e1])
  world6.defaultAckStatus = 503
  const db6 = openKeepaLocalDb(":memory:")
  const boot6 = await runCollectorBootstrap({ db: db6, http: world6.http, pageSize: 10, nowMs: Date.parse(t0) })
  assert.equal(boot6.ok, false)
  assert.notEqual(bootstrapPhase(db6), "COMPLETE")
  const scan6 = await runKeepaCollectorOnceBatches(scanCfg, db6, {
    keepaFetch: async () => {
      throw new Error("keepa")
    },
  })
  assert.equal(scan6.keepaCalls, 0)
  console.log("PASS C6 ACK 5xx no COMPLETE ackCalls=", world6.ackCalls, "keepa=", scan6.keepaCalls)

  const world7 = mockWorld([base], [e1])
  world7.defaultAckStatus = 401
  const db7 = openKeepaLocalDb(":memory:")
  const boot7 = await runCollectorBootstrap({ db: db7, http: world7.http, pageSize: 10, nowMs: Date.parse(t0) })
  assert.equal(boot7.ok, false)
  assert.equal(keepaScanAllowed(db7).allowed, false)
  console.log("PASS C7 ACK 401 fail-closed ackCalls=", world7.ackCalls, "keepa=0")

  const world8 = mockWorld([base], [e1])
  const db8 = openKeepaLocalDb(":memory:")
  const extra = ev("9", "B0KSSNAP04", { createdAt: tLate, sourceVersion: 1 })
  const boot8 = await runCollectorBootstrap({
    db: db8,
    http: world8.http,
    pageSize: 10,
    nowMs: Date.parse(t0),
    hooks: {
      afterLocalCommit: () => {
        world8.injectEvent(extra)
      },
    },
  })
  assert.equal(boot8.ok, true)
  assert.ok(db8.prepare("SELECT asin FROM asin_registry WHERE asin='B0KSSNAP04'").get())
  console.log("PASS C8 catch-up new event COMPLETE ackCalls=", world8.ackCalls, "keepa=0")

  const world9 = mockWorld([base], [e1])
  const db9 = openKeepaLocalDb(":memory:")
  let n = 10
  const origGet = world9.http.getJson
  world9.http.getJson = async pathName => {
    if (pathName.startsWith("/internal/keepa-collector/events") && n < 20) {
      n++
      const spawned = ev(String(n), `B0KCATCH${String(n).padStart(2, "0")}`, { createdAt: tLate })
      world9.injectEvent(spawned)
    }
    return origGet(pathName)
  }
  const boot9 = await runCollectorBootstrap({
    db: db9,
    http: world9.http,
    pageSize: 10,
    nowMs: Date.parse(t0),
    hooks: { catchUpMaxRounds: 2 },
  })
  assert.equal(boot9.ok, false)
  assert.equal((boot9 as { error: string }).error, "CATCHUP_LIMIT")
  assert.equal(keepaScanAllowed(db9).allowed, false)
  console.log("PASS C9 catch-up limit ackCalls=", world9.ackCalls, "keepa=0")

  const pre = ev("0", "B0KSSNAP01", { createdAt: "2026-09-21T11:59:00.000Z" })
  const world10 = mockWorld([base], [e1, pre])
  const db10 = openKeepaLocalDb(":memory:")
  const boot10 = await runCollectorBootstrap({
    db: db10,
    http: world10.http,
    pageSize: 10,
    nowMs: Date.parse(t0),
    hooks: { beforeBootstrapComplete: () => { throw new CrashSimError("CRASH_BEFORE_COMPLETE") } },
  })
  assert.equal(boot10.ok, false)
  assert.equal(world10.covered.length, 0)
  console.log("PASS C10 before bootstrap-complete pre-watermark still PENDING covered=", world10.covered.length, "ackCalls=", world10.ackCalls)

  const world11 = mockWorld([base], [e1, pre])
  const db11 = openKeepaLocalDb(":memory:")
  const boot11a = await runCollectorBootstrap({
    db: db11,
    http: world11.http,
    pageSize: 10,
    nowMs: Date.parse(t0),
    hooks: { afterRemoteBootstrapComplete: () => { throw new CrashSimError("CRASH_AFTER_REMOTE_COMPLETE") } },
  })
  assert.equal(boot11a.ok, false)
  assert.notEqual(bootstrapPhase(db11), "COMPLETE")
  const boot11b = await runCollectorBootstrap({ db: db11, http: world11.http, pageSize: 10, nowMs: Date.parse(t0) })
  assert.equal(boot11b.ok, true)
  assert.equal(bootstrapPhase(db11), "COMPLETE")
  console.log("PASS C11 remote complete then local crash idempotent finalize ackCalls=", world11.ackCalls)

  assert.equal(shouldMarkCoveredBySnapshot({ createdAt: tLate, snapshotStartedAt: t0, status: "PENDING" }), false)
  console.log("PASS C12 watermark-after not covered")

  const db13 = openKeepaLocalDb(":memory:")
  applySyncEvent(db13, {
    eventId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
    asin: "B0KREPLAY01",
    eventType: "ASIN_UPSERT",
    sourceVersion: 2,
    payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
    nowMs: 10,
    }, { remoteAckStatus: "ACKED_REMOTE" })
  applySyncEvent(db13, {
    eventId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
    asin: "B0KREPLAY01",
    eventType: "ASIN_UPSERT",
    sourceVersion: 9,
    payload: { status: "PAUSED_QTY_ZERO", activeConsumerCount: 0, priority: "STANDARD", cadenceHours: 24 },
    nowMs: 11,
  })
  const row13 = db13.prepare("SELECT status, source_version AS v FROM asin_registry WHERE asin='B0KREPLAY01'").get() as { status: string; v: number }
  assert.equal(row13.status, "ACTIVE")
  assert.equal(row13.v, 2)
  console.log("PASS C13 duplicate event does not re-apply")

  applySyncEvent(db13, {
    eventId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2",
    asin: "B0KREPLAY01",
    eventType: "ASIN_UPSERT",
    sourceVersion: 1,
    payload: { status: "PAUSED_QTY_ZERO", activeConsumerCount: 0, priority: "STANDARD", cadenceHours: 24 },
    nowMs: 12,
    }, { remoteAckStatus: "ACKED_REMOTE" })
  const row14 = db13.prepare("SELECT status, source_version AS v FROM asin_registry WHERE asin='B0KREPLAY01'").get() as { status: string; v: number }
  assert.equal(row14.status, "ACTIVE")
  assert.equal(row14.v, 2)
  console.log("PASS C14 sourceVersion does not regress")

  const db15 = openKeepaLocalDb(":memory:")
  applySyncEvent(db15, {
    eventId: "cccccccc-cccc-cccc-cccc-cccccccccc01",
    asin: asinAt(1),
    eventType: "ASIN_UPSERT",
    sourceVersion: 1,
    payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
    nowMs: 1,
  })
  setWorkerState(db15, "bootstrap_status", "COMPLETE")
  setWorkerState(db15, "central_reconcile_hash", localReconcileManifest(db15).hash)
  assert.ok(pendingAckCount(db15) > 0)
  assert.equal(keepaScanAllowed(db15).allowed, false)
  console.log("PASS C15 COMPLETE+pending ACK scan 0 keepa=0")

  let keepa16 = 0
  const bootOnly = await runKeepaCollector({
    env: {
      KEEPA_COLLECTOR_ENABLED: "true",
      KEEPA_COLLECTOR_RUN_MODE: "bootstrap-only",
      LISTJETGO_API_BASE: "http://local",
      KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
      KEEPA_LOCAL_DB_PATH: `${tmpdir()}/kc-104-${Date.now()}.sqlite`,
      KEEPA_ENABLED: "true",
      KEEPA_API_KEY: "k",
    },
    http: mockWorld([base]).http,
    skipLock: true,
    keepaFetch: async () => {
      keepa16++
      throw new Error("keepa")
    },
  })
  assert.equal(bootOnly.exitCode, 0)
  assert.equal(keepa16, 0)
  console.log("PASS C16 bootstrap-only keepa=", keepa16, "ack via mock")

  const db17 = openKeepaLocalDb(":memory:")
  for (let i = 1; i <= 8; i++) {
    applySyncEvent(db17, {
      eventId: `cccccccc-cccc-cccc-cccc-cccccccccc${String(i).padStart(2, "0")}`,
      asin: asinAt(i),
      eventType: "ASIN_UPSERT",
      sourceVersion: 1,
      payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
      nowMs: 1,
    }, { remoteAckStatus: "ACKED_REMOTE" })
  }
  setWorkerState(db17, "bootstrap_status", "COMPLETE")
  setWorkerState(db17, "central_reconcile_hash", localReconcileManifest(db17).hash)
  const batches: number[] = []
  const once = await runKeepaCollectorOnceBatches(scanCfg, db17, {
    keepaFetch: async input => {
      batches.push(input.asins.length)
      return { ok: true, status: 200, durationMs: 1, body: { products: input.asins.map(a => ({ asin: a })) } }
    },
  })
  assert.equal(once.batches, 1)
  assert.equal(batches.length, 1)
  assert.ok(batches[0] <= 5)
  console.log("PASS C17 once maxBatches=1 keepaCalls=", once.keepaCalls, "secondBatch=0")
  console.log("PASS keepa-collector 1.0.4 crash/ack fixtures")
}

void main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .then(() => process.exit(0))
