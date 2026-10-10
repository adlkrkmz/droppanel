import type { DatabaseSync } from "node:sqlite"
import {
  applySyncEvent,
  bootstrapPhase,
  bootstrapStatus,
  clearStaging,
  commitSwapAndPendingAcks,
  eventPayloadFingerprint,
  getWorkerState,
  insertStagingRow,
  keepaScanAllowed,
  listPendingAckIds,
  localReconcileManifest,
  markAckAttempt,
  markAckedRemote,
  pendingAckCount,
  setBootstrapPhase,
  setWorkerState,
  stagingCount,
  unauthorizedAckCount,
  type LedgerEvent,
  type SnapshotItem,
} from "./keepaLocalDb"
import { KEEPA_COLLECTOR_CATCHUP_MAX_ROUNDS_DEFAULT, KEEPA_COLLECTOR_VERSION } from "./keepaCollectorVersion"

export type CollectorHttp = {
  getJson: (path: string) => Promise<{ status: number; json: Record<string, unknown> }>
  postJson: (path: string, body?: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>
}

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BootstrapError"
  }
}

export class CrashSimError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CrashSimError"
  }
}

export type BootstrapHooks = {
  afterEventPull?: () => void
  afterStagingApply?: () => void
  afterLocalCommit?: () => void
  beforeMarkAckedRemote?: (eventId: string) => void
  beforeBootstrapComplete?: () => void
  afterRemoteBootstrapComplete?: () => void
  catchUpMaxRounds?: number
}

function asItems(raw: unknown): SnapshotItem[] {
  if (!Array.isArray(raw)) throw new BootstrapError("SNAPSHOT_INVALID_ITEMS")
  return raw.map((row, i) => {
    const r = row as Record<string, unknown>
    const asin = String(r.asin ?? "").trim().toUpperCase()
    const status = String(r.status ?? "")
    const priority = String(r.priority ?? "")
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new BootstrapError("SNAPSHOT_INVALID_ASIN")
    if (status !== "ACTIVE" && status !== "PAUSED_QTY_ZERO" && status !== "REMOVED") {
      throw new BootstrapError("SNAPSHOT_INVALID_STATUS")
    }
    if (priority !== "SOLD" && priority !== "STANDARD") throw new BootstrapError("SNAPSHOT_INVALID_PRIORITY")
    const cadenceHours = Number(r.cadenceHours)
    if (cadenceHours !== 12 && cadenceHours !== 24 && cadenceHours !== 120) throw new BootstrapError("SNAPSHOT_INVALID_CADENCE")
    return {
      asin,
      activeConsumerCount: Number(r.activeConsumerCount) || 0,
      status,
      priority,
      cadenceHours,
      sourceVersion: Number(r.sourceVersion) || 0,
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : undefined,
      queueSeq: Number(r.queueSeq) || i + 1,
    }
  })
}

export function parsePulledEvent(ev: Record<string, unknown>): {
  eventId: string
  asin: string
  eventType: string
  sourceVersion: number
  createdAt: string
  payload: {
    activeConsumerCount: number
    status: string
    priority: string
    cadenceHours: number
  }
  fingerprint: string
} {
  const eventId = String(ev.eventId ?? "")
  const asin = String(ev.asin ?? "")
  const eventType = String(ev.eventType ?? "")
  const sourceVersion = Number(ev.sourceVersion) || 0
  const payloadRaw = (ev.payload ?? {}) as Record<string, unknown>
  const payload = {
    activeConsumerCount: Number(payloadRaw.activeConsumerCount),
    status: String(payloadRaw.status ?? "ACTIVE"),
    priority: String(payloadRaw.priority ?? "STANDARD"),
    cadenceHours: Number(payloadRaw.cadenceHours) || 24,
  }
  return {
    eventId,
    asin,
    eventType,
    sourceVersion,
    createdAt: String(ev.createdAt ?? ""),
    payload,
    fingerprint: eventPayloadFingerprint({
      eventType,
      asin,
      sourceVersion,
      status: payload.status,
      priority: payload.priority,
      cadenceHours: payload.cadenceHours,
      activeConsumerCount: payload.activeConsumerCount,
    }),
  }
}

export async function downloadSnapshotToStaging(input: {
  db: DatabaseSync
  http: CollectorHttp
  pageSize: number
  nowMs: number
  keepPhase?: boolean
}): Promise<{ received: number; pages: number; snapshotStartedAt: string; totalsHashHint: string | null }> {
  const { db, http, pageSize, nowMs } = input
  const priorPhase = bootstrapPhase(db)
  if (!input.keepPhase) setBootstrapPhase(db, "SNAPSHOTTING")
  setWorkerState(db, "collector_version", KEEPA_COLLECTOR_VERSION)
  clearStaging(db)
  setWorkerState(db, "snapshot_cursor", "")
  setWorkerState(db, "snapshot_page_count", "0")
  setWorkerState(db, "snapshot_received_count", "0")

  let cursor = ""
  let offsetSeq = 0
  let pages = 0
  let received = 0
  let lastAsin = ""
  let snapshotStartedAt = ""
  const seen = new Set<string>()
  const totalsHashHint: string | null = null

  for (;;) {
    const qs = new URLSearchParams({ limit: String(pageSize), offsetSeq: String(offsetSeq) })
    if (cursor) qs.set("cursor", cursor)
    const res = await http.getJson(`/internal/keepa-collector/snapshot?${qs.toString()}`)
    if (res.status !== 200) throw new BootstrapError(`SNAPSHOT_HTTP_${res.status}`)
    const items = asItems(res.json.items)
    if (pages === 0) {
      const wm = res.json.watermark as { snapshotStartedAt?: string } | undefined
      snapshotStartedAt = String(wm?.snapshotStartedAt ?? "")
      if (!snapshotStartedAt) throw new BootstrapError("SNAPSHOT_WATERMARK_MISSING")
      setWorkerState(db, "snapshot_started_at", snapshotStartedAt)
      if (input.keepPhase) setWorkerState(db, "repair_snapshot_started_at", snapshotStartedAt)
    }
    for (const item of items) {
      if (lastAsin && item.asin <= lastAsin) throw new BootstrapError("SNAPSHOT_CURSOR_LOOP")
      if (seen.has(item.asin)) throw new BootstrapError("SNAPSHOT_DUPLICATE_ASIN")
      seen.add(item.asin)
      lastAsin = item.asin
      try {
        insertStagingRow(db, item, nowMs)
      } catch {
        throw new BootstrapError("SNAPSHOT_DUPLICATE_ASIN")
      }
      received++
    }
    pages++
    offsetSeq = Number(res.json.offsetSeq ?? offsetSeq + items.length)
    setWorkerState(db, "snapshot_page_count", String(pages))
    setWorkerState(db, "snapshot_received_count", String(received))
    const next = res.json.nextCursor == null || res.json.nextCursor === "" ? null : String(res.json.nextCursor)
    if (next && next === cursor) throw new BootstrapError("SNAPSHOT_CURSOR_LOOP")
    if (next && cursor && next <= cursor) throw new BootstrapError("SNAPSHOT_CURSOR_LOOP")
    setWorkerState(db, "snapshot_cursor", next ?? "")
    if (!next) break
    cursor = next
    if (pages > 5000) throw new BootstrapError("SNAPSHOT_PAGE_LIMIT")
  }
  if (input.keepPhase) setBootstrapPhase(db, priorPhase)
  if (received === 0 && stagingCount(db) === 0) {
    /* empty registry is valid COMPLETE candidate after reconcile */
  }
  return { received, pages, snapshotStartedAt, totalsHashHint }
}

export async function pullEventsSince(input: {
  http: CollectorHttp
  sinceCreatedAt: string
  afterEventId?: string
}): Promise<Array<ReturnType<typeof parsePulledEvent>>> {
  const pulled: Array<ReturnType<typeof parsePulledEvent>> = []
  let afterEventId = input.afterEventId ?? ""
  const seen = new Set<string>()
  for (let page = 0; page < 5000; page++) {
    const qs = new URLSearchParams({ limit: "100", sinceCreatedAt: input.sinceCreatedAt })
    if (afterEventId) qs.set("afterEventId", afterEventId)
    const res = await input.http.getJson(`/internal/keepa-collector/events?${qs.toString()}`)
    if (res.status !== 200) throw new BootstrapError(`EVENTS_HTTP_${res.status}`)
    const events = Array.isArray(res.json.events) ? (res.json.events as Record<string, unknown>[]) : []
    if (events.length === 0) break
    for (const ev of events) {
      const parsed = parsePulledEvent(ev)
      if (seen.has(parsed.eventId)) throw new BootstrapError("EVENTS_CURSOR_LOOP")
      seen.add(parsed.eventId)
      pulled.push(parsed)
      afterEventId = parsed.eventId
    }
    if (events.length < 100) break
  }
  return pulled
}

/** Pull only. Never remote-ACK. */
export async function replayEventsSince(input: {
  db: DatabaseSync
  http: CollectorHttp
  sinceCreatedAt: string
  nowMs: number
  table?: "asin_registry" | "asin_registry_staging"
  recordSync?: boolean
}): Promise<{
  applied: number
  acked: number
  lastEventId: string | null
  lastCreatedAt: string | null
  appliedEvents: LedgerEvent[]
}> {
  const pulled = await pullEventsSince({ http: input.http, sinceCreatedAt: input.sinceCreatedAt })
  const appliedEvents: LedgerEvent[] = []
  let applied = 0
  let lastEventId: string | null = null
  let lastCreatedAt: string | null = null
  for (const ev of pulled) {
    applySyncEvent(
      input.db,
      {
        eventId: ev.eventId,
        asin: ev.asin,
        eventType: ev.eventType,
        sourceVersion: ev.sourceVersion,
        payload: ev.payload,
        nowMs: input.nowMs,
      },
      { table: input.table ?? "asin_registry", recordSync: input.recordSync !== false }
    )
    applied++
    appliedEvents.push({
      eventId: ev.eventId,
      asin: ev.asin,
      eventType: ev.eventType,
      sourceVersion: ev.sourceVersion,
      fingerprint: ev.fingerprint,
    })
    lastEventId = ev.eventId
    lastCreatedAt = ev.createdAt || lastCreatedAt
  }
  if (lastEventId) setWorkerState(input.db, "last_event_watermark", lastEventId)
  if (lastCreatedAt) setWorkerState(input.db, "last_event_created_at", lastCreatedAt)
  return { applied, acked: 0, lastEventId, lastCreatedAt, appliedEvents }
}

export async function flushPendingRemoteAcks(input: {
  db: DatabaseSync
  http: CollectorHttp
  nowMs: number
  hooks?: BootstrapHooks
}): Promise<{ acked: number; pending: number }> {
  const ids = listPendingAckIds(input.db)
  let acked = 0
  for (const eventId of ids) {
    const res = await input.http.postJson("/internal/keepa-collector/ack", { eventIds: [eventId] })
    if (res.status === 401 || res.status === 403) {
      markAckAttempt(input.db, eventId, input.nowMs, `HTTP_${res.status}`)
      throw new BootstrapError(`ACK_UNAUTHORIZED_${res.status}`)
    }
    if (res.status !== 200 || res.json.ok !== true) {
      const code = res.status === 0 ? "ACK_TIMEOUT" : `HTTP_${res.status}`
      markAckAttempt(input.db, eventId, input.nowMs, code)
      throw new BootstrapError(`ACK_${code}`)
    }
    input.hooks?.beforeMarkAckedRemote?.(eventId)
    markAckedRemote(input.db, eventId, input.nowMs)
    acked++
  }
  return { acked, pending: pendingAckCount(input.db) }
}

function assertManifestMatch(local: ReturnType<typeof localReconcileManifest>, rec: Record<string, unknown>): void {
  const centralHash = String(rec.hash ?? rec.manifestHash ?? "")
  if (!centralHash || centralHash !== local.hash) throw new BootstrapError("RECONCILE_MISMATCH")
  if (Number(rec.count ?? local.uniqueAsins) !== local.uniqueAsins) throw new BootstrapError("RECONCILE_MISMATCH")
  if (Number(rec.active ?? local.active) !== local.active) throw new BootstrapError("RECONCILE_MISMATCH")
  if (Number(rec.pausedQtyZero ?? local.pausedQtyZero) !== local.pausedQtyZero) {
    throw new BootstrapError("RECONCILE_MISMATCH")
  }
  if (Number(rec.sold ?? local.sold) !== local.sold) throw new BootstrapError("RECONCILE_MISMATCH")
  if (Number(rec.standard ?? local.standard) !== local.standard) throw new BootstrapError("RECONCILE_MISMATCH")
}

async function postBootstrapComplete(input: {
  db: DatabaseSync
  http: CollectorHttp
  nowMs: number
  hooks?: BootstrapHooks
}): Promise<void> {
  const snapshotStartedAt = getWorkerState(input.db, "snapshot_started_at") ?? ""
  const local = localReconcileManifest(input.db)
  const requestId = getWorkerState(input.db, "bootstrap_request_id") ?? `kc-boot-${input.nowMs}`
  setWorkerState(input.db, "bootstrap_request_id", requestId)
  input.hooks?.beforeBootstrapComplete?.()
  const complete = await input.http.postJson("/internal/keepa-collector/bootstrap-complete", {
    snapshotStartedAt,
    localCount: local.uniqueAsins,
    localHash: local.hash,
    lastAppliedEventWatermark: {
      eventId: getWorkerState(input.db, "last_event_watermark"),
      createdAt: getWorkerState(input.db, "last_event_created_at"),
    },
    collectorVersion: KEEPA_COLLECTOR_VERSION,
    requestId,
  })
  if (complete.status !== 200 || complete.json.ok !== true) {
    throw new BootstrapError(`BOOTSTRAP_COMPLETE_HTTP_${complete.status}`)
  }
  input.hooks?.afterRemoteBootstrapComplete?.()
  setWorkerState(input.db, "central_reconcile_hash", local.hash)
  setWorkerState(input.db, "central_reconcile_count", String(local.uniqueAsins))
  setWorkerState(input.db, "bootstrap_completed_at", new Date(input.nowMs).toISOString())
  setWorkerState(input.db, "collector_version", KEEPA_COLLECTOR_VERSION)
  setBootstrapPhase(input.db, "COMPLETE")
}

async function catchUpAndFinalize(input: {
  db: DatabaseSync
  http: CollectorHttp
  nowMs: number
  hooks?: BootstrapHooks
}): Promise<void> {
  setBootstrapPhase(input.db, "FINALIZING")
  const maxRounds = input.hooks?.catchUpMaxRounds ?? KEEPA_COLLECTOR_CATCHUP_MAX_ROUNDS_DEFAULT
  for (let round = 1; round <= maxRounds; round++) {
    const since =
      getWorkerState(input.db, "last_event_created_at") ||
      getWorkerState(input.db, "snapshot_started_at") ||
      new Date(0).toISOString()
    const after = getWorkerState(input.db, "last_event_watermark") || ""
    const pulled = await pullEventsSince({
      http: input.http,
      sinceCreatedAt: since,
      afterEventId: after || undefined,
    })
    let appliedNew = 0
    for (const ev of pulled) {
      const changed = applySyncEvent(
        input.db,
        {
          eventId: ev.eventId,
          asin: ev.asin,
          eventType: ev.eventType,
          sourceVersion: ev.sourceVersion,
          payload: ev.payload,
          nowMs: input.nowMs,
        },
        { table: "asin_registry", recordSync: true, remoteAckStatus: "PENDING_ACK" }
      )
      if (changed || pendingAckCount(input.db) > 0) appliedNew++
      setWorkerState(input.db, "last_event_watermark", ev.eventId)
      if (ev.createdAt) setWorkerState(input.db, "last_event_created_at", ev.createdAt)
    }
    if (appliedNew > 0 && pendingAckCount(input.db) > 0) {
      await flushPendingRemoteAcks({ db: input.db, http: input.http, nowMs: input.nowMs, hooks: input.hooks })
      continue
    }
    const rec = await input.http.getJson("/internal/keepa-collector/reconcile")
    if (rec.status !== 200) throw new BootstrapError(`RECONCILE_HTTP_${rec.status}`)
    const local = localReconcileManifest(input.db)
    assertManifestMatch(local, rec.json)
    if (pendingAckCount(input.db) > 0) throw new BootstrapError("PENDING_ACK")
    await postBootstrapComplete(input)
    return
  }
  throw new BootstrapError("CATCHUP_LIMIT")
}

async function resumeAfterCommit(input: {
  db: DatabaseSync
  http: CollectorHttp
  nowMs: number
  hooks?: BootstrapHooks
}): Promise<{ ok: true; localHash: string; received: number }> {
  const phase = bootstrapPhase(input.db)
  if (phase === "COMMITTED_PENDING_ACK") {
    await flushPendingRemoteAcks({ db: input.db, http: input.http, nowMs: input.nowMs, hooks: input.hooks })
  }
  if (unauthorizedAckCount(input.db) > 0) throw new BootstrapError("ACK_UNAUTHORIZED")
  if (pendingAckCount(input.db) > 0) throw new BootstrapError("PENDING_ACK")
  await catchUpAndFinalize(input)
  const local = localReconcileManifest(input.db)
  return { ok: true, localHash: local.hash, received: Number(getWorkerState(input.db, "snapshot_received_count") ?? 0) }
}

export async function runCollectorBootstrap(input: {
  db: DatabaseSync
  http: CollectorHttp
  pageSize: number
  nowMs?: number
  hooks?: BootstrapHooks
}): Promise<{ ok: true; localHash: string; received: number } | { ok: false; error: string; phase: string }> {
  const nowMs = input.nowMs ?? Date.now()
  const phase = bootstrapPhase(input.db)
  try {
    if (phase === "COMPLETE") {
      const gate = keepaScanAllowed(input.db)
      if (!gate.allowed && gate.reason === "PENDING_ACK") {
        await flushPendingRemoteAcks({ db: input.db, http: input.http, nowMs, hooks: input.hooks })
      }
      const again = keepaScanAllowed(input.db)
      if (again.allowed || bootstrapPhase(input.db) === "COMPLETE" && pendingAckCount(input.db) === 0) {
        const local = localReconcileManifest(input.db)
        const rec = await input.http.getJson("/internal/keepa-collector/reconcile")
        if (rec.status === 200) {
          try {
            assertManifestMatch(local, rec.json)
            return { ok: true, localHash: local.hash, received: Number(getWorkerState(input.db, "snapshot_received_count") ?? 0) }
          } catch {
            /* fall through to rebuild */
          }
        }
      }
    }
    if (phase === "COMMITTED_PENDING_ACK" || phase === "FINALIZING") {
      return await resumeAfterCommit({ db: input.db, http: input.http, nowMs, hooks: input.hooks })
    }

    const snap = await downloadSnapshotToStaging({
      db: input.db,
      http: input.http,
      pageSize: input.pageSize,
      nowMs,
    })
    setBootstrapPhase(input.db, "STAGING_EVENTS")
    const pulled = await pullEventsSince({ http: input.http, sinceCreatedAt: snap.snapshotStartedAt })
    input.hooks?.afterEventPull?.()
    const ledger: LedgerEvent[] = []
    let lastEventId: string | null = null
    let lastCreatedAt: string | null = null
    for (const ev of pulled) {
      applySyncEvent(
        input.db,
        {
          eventId: ev.eventId,
          asin: ev.asin,
          eventType: ev.eventType,
          sourceVersion: ev.sourceVersion,
          payload: ev.payload,
          nowMs,
        },
        { table: "asin_registry_staging", recordSync: false }
      )
      ledger.push({
        eventId: ev.eventId,
        asin: ev.asin,
        eventType: ev.eventType,
        sourceVersion: ev.sourceVersion,
        fingerprint: ev.fingerprint,
      })
      lastEventId = ev.eventId
      lastCreatedAt = ev.createdAt || lastCreatedAt
    }
    input.hooks?.afterStagingApply?.()
    if (lastEventId) setWorkerState(input.db, "last_event_watermark", lastEventId)
    if (lastCreatedAt) setWorkerState(input.db, "last_event_created_at", lastCreatedAt)

    const checkpoint = await input.http.getJson("/internal/keepa-collector/reconcile")
    if (checkpoint.status !== 200) throw new BootstrapError(`RECONCILE_HTTP_${checkpoint.status}`)
    const localStaging = localReconcileManifest(input.db, "asin_registry_staging")
    assertManifestMatch(localStaging, checkpoint.json)

    if (!getWorkerState(input.db, "bootstrap_request_id")) {
      setWorkerState(input.db, "bootstrap_request_id", `kc-boot-${nowMs}`)
    }
    commitSwapAndPendingAcks(input.db, ledger, nowMs)
    input.hooks?.afterLocalCommit?.()
    await flushPendingRemoteAcks({ db: input.db, http: input.http, nowMs, hooks: input.hooks })
    await catchUpAndFinalize({ db: input.db, http: input.http, nowMs, hooks: input.hooks })
    const local = localReconcileManifest(input.db)
    return { ok: true, localHash: local.hash, received: snap.received }
  } catch (e) {
    const phaseNow = bootstrapPhase(input.db)
    const preserved = phaseNow === "COMMITTED_PENDING_ACK" || phaseNow === "FINALIZING" || phaseNow === "COMPLETE"
    if (!preserved) {
      setBootstrapPhase(input.db, "FAILED")
      clearStaging(input.db)
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e), phase: bootstrapPhase(input.db) }
  }
}

export { keepaScanAllowed, bootstrapStatus, bootstrapPhase }
