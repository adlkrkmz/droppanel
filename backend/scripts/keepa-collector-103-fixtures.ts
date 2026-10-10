import assert from "assert"
import fs from "fs"
import { tmpdir } from "os"
import {
  acquireCollectorProcessLock,
  CollectorLockError,
} from "../modules/keepaSensor/keepaCollectorLock"
import {
  applySyncEvent,
  bootstrapStatus,
  candidateCount,
  keepaScanAllowed,
  localReconcileManifest,
  openKeepaLocalDb,
  registryCount,
  setWorkerState,
  snapshotCount,
  stagingCount,
  type SnapshotItem,
} from "../modules/keepaSensor/keepaLocalDb"
import { runCollectorBootstrap, type CollectorHttp } from "../modules/keepaSensor/keepaCollectorBootstrap"
import { computeKeepaReconcileManifest } from "../modules/keepaSensor/keepaCollectorReconcile"
import { shouldMarkCoveredBySnapshot } from "../modules/keepaSensor/keepaCollectorCovered"
import {
  loadKeepaCollectorConfig,
  runKeepaCollector,
  runKeepaCollectorOnceBatches,
  sanitizeErr,
  scanDueAsins,
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

function pagesOf(countPages: number, perPage: number): SnapshotItem[][] {
  const pages: SnapshotItem[][] = []
  let n = 0
  for (let p = 0; p < countPages; p++) {
    const page: SnapshotItem[] = []
    for (let i = 0; i < perPage; i++) {
      n++
      page.push(item(asinAt(n), { queueSeq: n }))
    }
    pages.push(page)
  }
  return pages
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

function mockSnapshotHttp(pages: SnapshotItem[][], events: Record<string, unknown>[] = []) {
  const manifest = computeKeepaReconcileManifest(projectedAfterEvents(pages, events))
  let failAtPage = -1
  const http: CollectorHttp = {
    async getJson(pathName: string) {
      if (pathName.startsWith("/internal/keepa-collector/snapshot")) {
        const url = new URL(pathName, "http://local")
        const cursor = url.searchParams.get("cursor") ?? ""
        const offsetSeq = parseInt(url.searchParams.get("offsetSeq") ?? "0", 10) || 0
        const pageIdx = cursor ? pages.findIndex(p => p[p.length - 1]?.asin === cursor) + 1 : 0
        if (failAtPage >= 0 && pageIdx === failAtPage) return { status: 500, json: { ok: false } }
        const page = pages[pageIdx] ?? []
        return {
          status: 200,
          json: {
            ok: true,
            items: page,
            nextCursor: pageIdx + 1 < pages.length ? page[page.length - 1].asin : null,
            offsetSeq: offsetSeq + page.length,
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
            duplicates: manifest.duplicates,
            sourceVersionRegressions: manifest.sourceVersionRegressions,
            eventHighWatermarkCreatedAt: events[events.length - 1] ? String(events[events.length - 1].createdAt) : "2026-09-21T12:00:00.000Z",
            eventHighWatermarkId: events[events.length - 1] ? String(events[events.length - 1].eventId) : null,
            generatedAt: "2026-09-21T12:00:10.000Z",
          },
        }
      }
      return { status: 404, json: {} }
    },
    async postJson(pathName: string) {
      if (pathName === "/internal/keepa-collector/ack") return { status: 200, json: { ok: true, acked: 1 } }
      if (pathName === "/internal/keepa-collector/bootstrap-complete") return { status: 200, json: { ok: true } }
      if (pathName === "/internal/keepa-collector/candidates") return { status: 200, json: { ok: true, created: true } }
      return { status: 404, json: {} }
    },
  }
  return {
    http,
    setFailAtPage(v: number) {
      failAtPage = v
    },
  }
}

async function main(): Promise<void> {
  const pages64 = pagesOf(64, 2)
  const all64 = pages64.flat()
  const mock1 = mockSnapshotHttp(pages64)
  const db1 = openKeepaLocalDb(":memory:")
  const boot1 = await runCollectorBootstrap({ db: db1, http: mock1.http, pageSize: 2, nowMs: 1_000_000 })
  assert.equal(boot1.ok, true)
  assert.equal(bootstrapStatus(db1), "COMPLETE")
  assert.equal(registryCount(db1), all64.length)
  assert.equal(keepaScanAllowed(db1).allowed, true)
  console.log("PASS 1 64-page snapshot → COMPLETE")

  const mock2 = mockSnapshotHttp(pages64)
  mock2.setFailAtPage(16)
  const db2 = openKeepaLocalDb(":memory:")
  const boot2 = await runCollectorBootstrap({ db: db2, http: mock2.http, pageSize: 2, nowMs: 1_000_000 })
  assert.equal(boot2.ok, false)
  assert.equal(registryCount(db2), 0)
  const scan2 = await scanDueAsins(
    loadKeepaCollectorConfig({
      KEEPA_COLLECTOR_ENABLED: "true",
      KEEPA_ENABLED: "true",
      KEEPA_COLLECTOR_RUN_MODE: "once",
      LISTJETGO_API_BASE: "http://local",
      KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
      KEEPA_API_KEY: "k",
    }),
    db2,
    { keepaFetch: async () => { throw new Error("keepa-should-not-run") } }
  )
  assert.equal(scan2.keepaCalls, 0)
  console.log("PASS 2 page-17 HTTP error → registry unchanged, scan 0")

  const db3 = openKeepaLocalDb(":memory:")
  const boot3 = await runCollectorBootstrap({
    db: db3,
    http: mockSnapshotHttp([[item("B0KAAAAAAA"), item("B0KAAAAAAA")]]).http,
    pageSize: 2,
    nowMs: 1,
  })
  assert.equal(boot3.ok, false)
  console.log("PASS 3 duplicate ASIN → fail")

  const loopHttp: CollectorHttp = {
    async getJson() {
      return {
        status: 200,
        json: {
          items: [item("B0KBBBBBBB", { queueSeq: 1 })],
          nextCursor: "B0KBBBBBBB",
          watermark: { snapshotStartedAt: "2026-09-21T12:00:00.000Z" },
        },
      }
    },
    async postJson() {
      return { status: 200, json: { ok: true } }
    },
  }
  const db4 = openKeepaLocalDb(":memory:")
  const boot4 = await runCollectorBootstrap({ db: db4, http: loopHttp, pageSize: 1, nowMs: 1 })
  assert.equal(boot4.ok, false)
  console.log("PASS 4 cursor loop → fail")

  const db5 = openKeepaLocalDb(":memory:")
  setWorkerState(db5, "bootstrap_status", "IN_PROGRESS")
  db5.prepare(
    `INSERT INTO asin_registry_staging (asin, active_consumer_count, status, priority, cadence_hours, next_scan_at, source_version, queue_seq, created_at, updated_at)
     VALUES ('B0KPARTIAL0', 1, 'ACTIVE', 'STANDARD', 24, 1, 1, 1, 1, 1)`
  ).run()
  const boot5 = await runCollectorBootstrap({
    db: db5,
    http: mockSnapshotHttp([[item("B0KNEW0001", { queueSeq: 1 })]]).http,
    pageSize: 1,
    nowMs: 2,
  })
  assert.equal(boot5.ok, true)
  assert.equal(stagingCount(db5), 0)
  const asins5 = db5.prepare("SELECT asin FROM asin_registry").all() as { asin: string }[]
  assert.deepEqual(asins5.map(r => r.asin), ["B0KNEW0001"])
  console.log("PASS 5 partial restart → clean restart from page 1")

  const t0 = "2026-09-21T12:00:00.000Z"
  const tMid = "2026-09-21T12:00:05.000Z"
  const base = [item("B0KSSNAP01", { queueSeq: 1 }), item("B0KSSNAP02", { queueSeq: 2, priority: "SOLD", cadenceHours: 12 })]
  const db6 = openKeepaLocalDb(":memory:")
  const boot6 = await runCollectorBootstrap({
    db: db6,
    http: mockSnapshotHttp([base], [
      {
        eventId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
        asin: "B0KSSNAP03",
        eventType: "ASIN_UPSERT",
        sourceVersion: 1,
        createdAt: tMid,
        payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
      },
    ]).http,
    pageSize: 10,
    nowMs: Date.parse(t0),
  })
  assert.equal(boot6.ok, true)
  assert.equal((db6.prepare("SELECT asin FROM asin_registry WHERE asin='B0KSSNAP03'").get() as { asin: string } | undefined)?.asin, "B0KSSNAP03")
  console.log("PASS 6 mid-snapshot new ASIN event replayed")

  const db7 = openKeepaLocalDb(":memory:")
  await runCollectorBootstrap({
    db: db7,
    http: mockSnapshotHttp([base], [
      {
        eventId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2",
        asin: "B0KSSNAP01",
        eventType: "QTY_ZERO_PAUSED",
        sourceVersion: 2,
        createdAt: tMid,
        payload: { status: "PAUSED_QTY_ZERO", activeConsumerCount: 0, priority: "STANDARD", cadenceHours: 24 },
      },
    ]).http,
    pageSize: 10,
    nowMs: Date.parse(t0),
  })
  assert.equal((db7.prepare("SELECT status FROM asin_registry WHERE asin='B0KSSNAP01'").get() as { status: string }).status, "PAUSED_QTY_ZERO")
  console.log("PASS 7 mid-snapshot qty0 → PAUSED")

  const db8 = openKeepaLocalDb(":memory:")
  await runCollectorBootstrap({
    db: db8,
    http: mockSnapshotHttp([base], [
      {
        eventId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3",
        asin: "B0KSSNAP02",
        eventType: "ASIN_REMOVED",
        sourceVersion: 2,
        createdAt: tMid,
        payload: { status: "REMOVED", activeConsumerCount: 0, priority: "STANDARD", cadenceHours: 24 },
      },
    ]).http,
    pageSize: 10,
    nowMs: Date.parse(t0),
  })
  assert.equal(db8.prepare("SELECT asin FROM asin_registry WHERE asin='B0KSSNAP02'").get(), undefined)
  console.log("PASS 8 mid-snapshot removal → local delete")

  assert.equal(shouldMarkCoveredBySnapshot({ createdAt: "2026-09-21T11:59:59.000Z", snapshotStartedAt: t0, status: "PENDING" }), true)
  assert.equal(shouldMarkCoveredBySnapshot({ createdAt: "2026-09-21T12:00:01.000Z", snapshotStartedAt: t0, status: "PENDING" }), false)
  console.log("PASS 9-10 watermark before covered, after not covered")

  const db11 = openKeepaLocalDb(":memory:")
  applySyncEvent(db11, {
    eventId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
    asin: "B0KREPLAY01",
    eventType: "ASIN_UPSERT",
    sourceVersion: 1,
    payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
    nowMs: 10,
  }, { remoteAckStatus: "ACKED_REMOTE" })
  assert.equal(
    applySyncEvent(db11, {
      eventId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
      asin: "B0KREPLAY01",
      eventType: "ASIN_UPSERT",
      sourceVersion: 1,
      payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
      nowMs: 11,
    }, { remoteAckStatus: "ACKED_REMOTE" }),
    false
  )
  console.log("PASS 11 event replay idempotent")

  const rows = [item("B0KHASH0001"), item("B0KHASH0002", { priority: "SOLD", cadenceHours: 12 })]
  assert.equal(computeKeepaReconcileManifest(rows).hash, computeKeepaReconcileManifest([...rows].reverse()).hash)
  console.log("PASS 12 reconcile hash order-independent match")

  const db13 = openKeepaLocalDb(":memory:")
  setWorkerState(db13, "bootstrap_status", "COMPLETE")
  setWorkerState(db13, "central_reconcile_hash", "deadbeef")
  assert.equal(keepaScanAllowed(db13).allowed, false)
  console.log("PASS 13 reconcile mismatch → scan 0")

  const bootOnly = await runKeepaCollector({
    env: {
      KEEPA_COLLECTOR_ENABLED: "true",
      KEEPA_COLLECTOR_RUN_MODE: "bootstrap-only",
      LISTJETGO_API_BASE: "http://local",
      KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
      KEEPA_COLLECTOR_BOOTSTRAP_PAGE_SIZE: "2",
      KEEPA_LOCAL_DB_PATH: `${tmpdir()}/kc-boot-only-${Date.now()}.sqlite`,
      KEEPA_ENABLED: "true",
      KEEPA_API_KEY: "secret-key-value",
    },
    http: mockSnapshotHttp(pagesOf(2, 1)).http,
    skipLock: true,
    keepaFetch: async () => {
      throw new Error("keepa-must-not-run")
    },
  })
  assert.equal(bootOnly.exitCode, 0)
  assert.equal(bootOnly.keepaCalls, 0)
  console.log("PASS 14 bootstrap-only Keepa HTTP 0")

  const db15 = openKeepaLocalDb(":memory:")
  for (let i = 1; i <= 8; i++) {
    applySyncEvent(db15, {
      eventId: `cccccccc-cccc-cccc-cccc-cccccccccc${String(i).padStart(2, "0")}`,
      asin: asinAt(i),
      eventType: "ASIN_UPSERT",
      sourceVersion: 1,
      payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
      nowMs: 1,
    }, { remoteAckStatus: "ACKED_REMOTE" })
  }
  applySyncEvent(db15, {
    eventId: "cccccccc-cccc-cccc-cccc-cccccccccc99",
    asin: "B0KPAUSED01",
    eventType: "ASIN_UPSERT",
    sourceVersion: 1,
    payload: { status: "PAUSED_QTY_ZERO", activeConsumerCount: 0, priority: "STANDARD", cadenceHours: 24 },
    nowMs: 1,
  }, { remoteAckStatus: "ACKED_REMOTE" })
  setWorkerState(db15, "bootstrap_status", "COMPLETE")
  setWorkerState(db15, "central_reconcile_hash", localReconcileManifest(db15).hash)
  const keepaAsins: string[][] = []
  const cfg15 = loadKeepaCollectorConfig({
    KEEPA_COLLECTOR_ENABLED: "true",
    KEEPA_ENABLED: "true",
    KEEPA_COLLECTOR_RUN_MODE: "once",
    KEEPA_COLLECTOR_MAX_BATCHES: "1",
    KEEPA_COLLECTOR_BATCH_SIZE: "5",
    LISTJETGO_API_BASE: "http://local",
    KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
    KEEPA_API_KEY: "k",
  })
  const once = await runKeepaCollectorOnceBatches(cfg15, db15, {
    keepaFetch: async input => {
      keepaAsins.push(input.asins)
      return {
        ok: true,
        status: 200,
        durationMs: 1,
        body: { products: input.asins.map(a => ({ asin: a })), tokensLeft: 42, refillIn: 1000 },
      }
    },
  })
  assert.equal(once.batches, 1)
  assert.ok(keepaAsins[0].length <= 5)
  assert.equal(keepaAsins.length, 1)
  assert.ok(!keepaAsins[0].includes("B0KPAUSED01"))
  console.log("PASS 15 once maxBatches=1 batch=5 → at most 5, second batch 0")
  console.log("PASS 18 PAUSED qty0 not selected")
  assert.equal(candidateCount(db15), 0)
  console.log("PASS 16 first baseline candidate 0")

  const db17 = openKeepaLocalDb(":memory:")
  applySyncEvent(db17, {
    eventId: "dddddddd-dddd-dddd-dddd-ddddddddddd1",
    asin: asinAt(1),
    eventType: "ASIN_UPSERT",
    sourceVersion: 1,
    payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
    nowMs: 1,
  }, { remoteAckStatus: "ACKED_REMOTE" })
  setWorkerState(db17, "bootstrap_status", "COMPLETE")
  setWorkerState(db17, "central_reconcile_hash", localReconcileManifest(db17).hash)
  await scanDueAsins(cfg15, db17, {
    keepaFetch: async () => ({ ok: false, status: 500, code: "HTTP_5XX", body: null, message: "err", durationMs: 1 }),
  })
  assert.equal(snapshotCount(db17), 0)
  console.log("PASS 17 API/parse error → baseline 0")

  const lockPath = `${tmpdir()}/kc-lock-test-${Date.now()}.sqlite`
  try {
    fs.unlinkSync(`${lockPath}.lock`)
  } catch {
    /* */
  }
  const l1 = acquireCollectorProcessLock(lockPath)
  let held = false
  try {
    acquireCollectorProcessLock(lockPath)
  } catch (e) {
    held = e instanceof CollectorLockError
  }
  l1.release()
  assert.equal(held, true)
  console.log("PASS 19 second collector process lock fails")

  const red = sanitizeErr("boom secret-key-value and tokentokentokentokentokenxxxx", "tokentokentokentokentokenxxxx", "secret-key-value")
  assert.equal(red.includes("secret-key-value"), false)
  assert.equal(red.includes("tokentokentokentokentokenxxxx"), false)
  console.log("PASS 20 token/API key redaction")

  const badMode = await runKeepaCollector({
    env: {
      KEEPA_COLLECTOR_ENABLED: "true",
      KEEPA_COLLECTOR_RUN_MODE: "not-a-mode",
      LISTJETGO_API_BASE: "http://x",
      KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
    },
    skipLock: true,
  })
  assert.equal(badMode.exitCode, 1)
  console.log("PASS invalid RUN_MODE does not start")
  console.log("PASS keepa-collector 1.0.3 fixtures")
}

void main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .then(() => process.exit(0))
