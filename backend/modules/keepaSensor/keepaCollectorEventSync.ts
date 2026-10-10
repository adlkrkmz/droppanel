import type { DatabaseSync } from "node:sqlite"
import {
  applySyncEvent,
  bootstrapPhase,
  getWorkerState,
  localReconcileManifest,
  pendingAckCount,
  setWorkerState,
  unauthorizedAckCount,
} from "./keepaLocalDb"
import {
  BootstrapError,
  CrashSimError,
  flushPendingRemoteAcks,
  pullEventsSince,
  type BootstrapHooks,
  type CollectorHttp,
} from "./keepaCollectorBootstrap"
import { KEEPA_COLLECTOR_CATCHUP_MAX_ROUNDS_DEFAULT } from "./keepaCollectorVersion"

export type EventSyncHooks = BootstrapHooks & {
  beforeLocalCommit?: () => void
  afterLocalCommit?: () => void
}

export type EventSyncResult = {
  pulled: number
  applied: number
  noop: number
  acked: number
  catchupRound: number
  localCommitted: boolean
  pendingAck: number
  reconcileMatched: boolean
  keepaAllowed: boolean
  error: string | null
  localCount: number
  localHash: string
  centralCount: number | null
  centralHash: string | null
  lastEventCreatedAt: string | null
  lastEventIdMasked: string | null
}

function maskEventId(id: string | null): string | null {
  if (!id) return null
  if (id.length < 8) return "••••"
  return `${id.slice(0, 4)}…${id.slice(-4)}`
}

function sinceForCatchup(db: DatabaseSync): { since: string; after?: string } {
  const snap = getWorkerState(db, "snapshot_started_at")
  const lastAt = getWorkerState(db, "last_event_created_at")
  const lastId = getWorkerState(db, "last_event_watermark")
  const floor = snap && snap.length > 0 ? snap : new Date(0).toISOString()
  if (lastAt && lastAt >= floor) return { since: lastAt, after: lastId || undefined }
  return { since: floor }
}

function applyBatch(
  db: DatabaseSync,
  events: Array<{
    eventId: string
    asin: string
    eventType: string
    sourceVersion: number
    createdAt: string
    payload: { activeConsumerCount: number; status: string; priority: string; cadenceHours: number }
  }>,
  nowMs: number
): { applied: number; noop: number } {
  let applied = 0
  let noop = 0
  db.exec("BEGIN")
  try {
    for (const ev of events) {
      const changed = applySyncEvent(
        db,
        {
          eventId: ev.eventId,
          asin: ev.asin,
          eventType: ev.eventType,
          sourceVersion: ev.sourceVersion,
          payload: ev.payload,
          nowMs,
        },
        { table: "asin_registry", recordSync: true, remoteAckStatus: "PENDING_ACK", inTransaction: true }
      )
      if (changed) applied++
      else noop++
      setWorkerState(db, "last_event_watermark", ev.eventId)
      if (ev.createdAt) setWorkerState(db, "last_event_created_at", ev.createdAt)
    }
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  return { applied, noop }
}

export async function catchUpLifecycleThenReconcile(input: {
  db: DatabaseSync
  http: CollectorHttp
  nowMs?: number
  catchUpMaxRounds?: number
  hooks?: EventSyncHooks
}): Promise<EventSyncResult> {
  const nowMs = input.nowMs ?? Date.now()
  const maxRounds = input.catchUpMaxRounds ?? KEEPA_COLLECTOR_CATCHUP_MAX_ROUNDS_DEFAULT
  const emptyLocal = localReconcileManifest(input.db)
  const base = (): EventSyncResult => ({
    pulled: 0,
    applied: 0,
    noop: 0,
    acked: 0,
    catchupRound: 0,
    localCommitted: false,
    pendingAck: pendingAckCount(input.db),
    reconcileMatched: false,
    keepaAllowed: false,
    error: null,
    localCount: emptyLocal.uniqueAsins,
    localHash: emptyLocal.hash,
    centralCount: null,
    centralHash: null,
    lastEventCreatedAt: getWorkerState(input.db, "last_event_created_at"),
    lastEventIdMasked: maskEventId(getWorkerState(input.db, "last_event_watermark")),
  })
  if (bootstrapPhase(input.db) !== "COMPLETE") {
    return { ...base(), error: `BOOTSTRAP_${bootstrapPhase(input.db)}` }
  }
  if (unauthorizedAckCount(input.db) > 0) {
    return { ...base(), error: "ACK_UNAUTHORIZED" }
  }

  let pulled = 0
  let applied = 0
  let noop = 0
  let acked = 0
  let localCommitted = false
  let round = 0

  const fail = (error: string): EventSyncResult => {
    const local = localReconcileManifest(input.db)
    return {
      ...base(),
      pulled,
      applied,
      noop,
      acked,
      catchupRound: round,
      localCommitted,
      pendingAck: pendingAckCount(input.db),
      error,
      localCount: local.uniqueAsins,
      localHash: local.hash,
      lastEventCreatedAt: getWorkerState(input.db, "last_event_created_at"),
      lastEventIdMasked: maskEventId(getWorkerState(input.db, "last_event_watermark")),
    }
  }

  try {
  if (pendingAckCount(input.db) > 0) {
    const flush = await flushPendingRemoteAcks({ db: input.db, http: input.http, nowMs, hooks: input.hooks })
    acked += flush.acked
  }

  for (round = 1; round <= maxRounds; round++) {
    const cursor = sinceForCatchup(input.db)
    const events = await pullEventsSince({
      http: input.http,
      sinceCreatedAt: cursor.since,
      afterEventId: cursor.after,
    })
    pulled += events.length
    if (events.length === 0) break
    input.hooks?.beforeLocalCommit?.()
    const batch = applyBatch(input.db, events, nowMs)
    applied += batch.applied
    noop += batch.noop
    localCommitted = true
    input.hooks?.afterLocalCommit?.()
    const flush = await flushPendingRemoteAcks({ db: input.db, http: input.http, nowMs, hooks: input.hooks })
    acked += flush.acked
    if (round === maxRounds) {
      const again = sinceForCatchup(input.db)
      const extra = await pullEventsSince({
        http: input.http,
        sinceCreatedAt: again.since,
        afterEventId: again.after,
      })
      if (extra.length > 0) {
        const local = localReconcileManifest(input.db)
        return {
          ...base(),
          pulled: pulled + extra.length,
          applied,
          noop,
          acked,
          catchupRound: round,
          localCommitted,
          pendingAck: pendingAckCount(input.db),
          error: "CATCHUP_LIMIT_EXCEEDED",
          localCount: local.uniqueAsins,
          localHash: local.hash,
          lastEventCreatedAt: getWorkerState(input.db, "last_event_created_at"),
          lastEventIdMasked: maskEventId(getWorkerState(input.db, "last_event_watermark")),
        }
      }
    }
  }

  if (pendingAckCount(input.db) > 0) {
    const local = localReconcileManifest(input.db)
    return {
      ...base(),
      pulled,
      applied,
      noop,
      acked,
      catchupRound: round,
      localCommitted,
      pendingAck: pendingAckCount(input.db),
      error: "PENDING_ACK",
      localCount: local.uniqueAsins,
      localHash: local.hash,
      lastEventCreatedAt: getWorkerState(input.db, "last_event_created_at"),
      lastEventIdMasked: maskEventId(getWorkerState(input.db, "last_event_watermark")),
    }
  }

  const rec = await input.http.getJson("/internal/keepa-collector/reconcile")
  const local = localReconcileManifest(input.db)
  const centralHash = rec.status === 200 ? String(rec.json.hash ?? "") : null
  const centralCount = rec.status === 200 ? Number(rec.json.count) : null
  const matched =
    rec.status === 200 &&
    centralHash === local.hash &&
    centralCount === local.uniqueAsins &&
    local.duplicates === 0 &&
    local.sourceVersionRegressions === 0
  if (matched) {
    setWorkerState(input.db, "central_reconcile_hash", local.hash)
    setWorkerState(input.db, "central_reconcile_count", String(local.uniqueAsins))
    setWorkerState(input.db, "last_error_code", "")
  } else {
    setWorkerState(input.db, "last_error_code", "SYNC_RECONCILE_MISMATCH")
  }
  return {
    pulled,
    applied,
    noop,
    acked,
    catchupRound: round,
    localCommitted,
    pendingAck: pendingAckCount(input.db),
    reconcileMatched: matched,
    keepaAllowed: matched,
    error: matched ? null : rec.status !== 200 ? `RECONCILE_HTTP_${rec.status}` : "SYNC_RECONCILE_MISMATCH",
    localCount: local.uniqueAsins,
    localHash: local.hash,
    centralCount: Number.isFinite(centralCount) ? centralCount : null,
    centralHash,
    lastEventCreatedAt: getWorkerState(input.db, "last_event_created_at"),
    lastEventIdMasked: maskEventId(getWorkerState(input.db, "last_event_watermark")),
  }
  } catch (e) {
    if (e instanceof CrashSimError) throw e
    if (e instanceof BootstrapError) return fail(e.message)
    throw e
  }
}

export function rethrowSyncCrash(e: unknown): never {
  if (e instanceof CrashSimError || e instanceof BootstrapError) throw e
  throw e
}
