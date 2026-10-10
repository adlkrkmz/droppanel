import type { DatabaseSync } from "node:sqlite"
import {
  bootstrapPhase,
  clearStaging,
  getWorkerState,
  localReconcileManifest,
  mergeStagingIntoRegistry,
  pendingAckCount,
  setBootstrapPhase,
  setWorkerState,
  stagingCount,
  type RepairMergeStats,
} from "./keepaLocalDb"
import {
  BootstrapError,
  CrashSimError,
  downloadSnapshotToStaging,
  type BootstrapHooks,
  type CollectorHttp,
} from "./keepaCollectorBootstrap"
import { catchUpLifecycleThenReconcile, type EventSyncHooks } from "./keepaCollectorEventSync"
import { KEEPA_COLLECTOR_VERSION } from "./keepaCollectorVersion"

export type RepairHooks = EventSyncHooks &
  BootstrapHooks & {
    beforeMergeCommit?: () => void
    afterMergeCommit?: () => void
    beforeRepairComplete?: () => void
    onProgress?: (partial: Record<string, unknown>) => Promise<void>
  }

export type RepairResult = {
  ok: boolean
  error: string | null
  keepaCalls: number
  localCount: number
  localHash: string
  centralCount: number | null
  centralHash: string | null
  merge: RepairMergeStats
  pulled: number
  applied: number
  acked: number
  requestId: string | null
}

function emptyMerge(): RepairMergeStats {
  return { added: 0, updated: 0, paused: 0, removed: 0, preserved: 0 }
}

function fail(db: DatabaseSync, error: string, extra: Partial<RepairResult> = {}): RepairResult {
  const local = localReconcileManifest(db)
  setWorkerState(db, "last_error_code", error)
  return {
    ok: false,
    error,
    keepaCalls: 0,
    localCount: local.uniqueAsins,
    localHash: local.hash,
    centralCount: extra.centralCount ?? null,
    centralHash: extra.centralHash ?? null,
    merge: extra.merge ?? emptyMerge(),
    pulled: extra.pulled ?? 0,
    applied: extra.applied ?? 0,
    acked: extra.acked ?? 0,
    requestId: getWorkerState(db, "repair_request_id"),
  }
}

async function postRepairComplete(input: {
  db: DatabaseSync
  http: CollectorHttp
  nowMs: number
  merge: RepairMergeStats
  hooks?: RepairHooks
}): Promise<{ ok: boolean; status: number; error: string | null }> {
  const local = localReconcileManifest(input.db)
  const requestId = getWorkerState(input.db, "repair_request_id") ?? `kc-repair-${input.nowMs}`
  setWorkerState(input.db, "repair_request_id", requestId)
  const snapshotStartedAt =
    getWorkerState(input.db, "repair_snapshot_started_at") || getWorkerState(input.db, "snapshot_started_at") || ""
  input.hooks?.beforeRepairComplete?.()
  const res = await input.http.postJson("/internal/keepa-collector/repair-complete", {
    requestId,
    collectorId: getWorkerState(input.db, "collector_id"),
    collectorVersion: KEEPA_COLLECTOR_VERSION,
    snapshotStartedAt,
    finalCount: local.uniqueAsins,
    finalHash: local.hash,
    added: input.merge.added,
    updated: input.merge.updated,
    paused: input.merge.paused,
    removed: input.merge.removed,
    preserved: input.merge.preserved,
  })
  if (res.status === 409) return { ok: false, status: 409, error: "REPAIR_COMPLETE_409" }
  if (res.status !== 200 || res.json.ok !== true) {
    return { ok: false, status: res.status, error: `REPAIR_COMPLETE_HTTP_${res.status}` }
  }
  setWorkerState(input.db, "central_reconcile_hash", local.hash)
  setWorkerState(input.db, "central_reconcile_count", String(local.uniqueAsins))
  setWorkerState(input.db, "last_error_code", "")
  setWorkerState(input.db, "repair_receipt", "1")
  return { ok: true, status: 200, error: null }
}

export function resetRepairSnapshotMergeGate(db: DatabaseSync, nowMs: number): void {
  db.prepare("DELETE FROM worker_state WHERE key = 'repair_merged'").run()
  setWorkerState(db, "repair_request_id", `kc-repair-${nowMs}`)
}

export async function runCollectorRepair(input: {
  db: DatabaseSync
  http: CollectorHttp
  pageSize: number
  nowMs?: number
  catchUpMaxRounds?: number
  hooks?: RepairHooks
  /** When true, ignore a prior repair_merged short-circuit and take snapshot merge if catch-up still mismatches. */
  forceSnapshotMerge?: boolean
}): Promise<RepairResult> {
  const nowMs = input.nowMs ?? Date.now()
  const db = input.db
  if (bootstrapPhase(db) !== "COMPLETE") {
    return fail(db, `BOOTSTRAP_${bootstrapPhase(db)}`)
  }
  let pulled = 0
  let applied = 0
  let acked = 0
  let merge = emptyMerge()
  try {
    await input.hooks?.onProgress?.({ syncState: "REPAIRING_REGISTRY" })
    if (input.forceSnapshotMerge) {
      resetRepairSnapshotMergeGate(db, nowMs)
    } else if (!getWorkerState(db, "repair_request_id")) {
      setWorkerState(db, "repair_request_id", `kc-repair-${nowMs}`)
    }
    if (getWorkerState(db, "repair_merged") === "1") {
      const sync = await catchUpLifecycleThenReconcile({
        db,
        http: input.http,
        nowMs,
        catchUpMaxRounds: input.catchUpMaxRounds,
        hooks: input.hooks,
      })
      pulled += sync.pulled
      applied += sync.applied
      acked += sync.acked
      if (sync.keepaAllowed) {
        const posted = await postRepairComplete({ db, http: input.http, nowMs, merge, hooks: input.hooks })
        if (!posted.ok) return fail(db, posted.error ?? "REPAIR_COMPLETE_FAILED", { pulled, applied, acked, merge })
        const local = localReconcileManifest(db)
        return {
          ok: true,
          error: null,
          keepaCalls: 0,
          localCount: local.uniqueAsins,
          localHash: local.hash,
          centralCount: local.uniqueAsins,
          centralHash: local.hash,
          merge,
          pulled,
          applied,
          acked,
          requestId: getWorkerState(db, "repair_request_id"),
        }
      }
      resetRepairSnapshotMergeGate(db, nowMs)
    }

    const sync = await catchUpLifecycleThenReconcile({
      db,
      http: input.http,
      nowMs,
      catchUpMaxRounds: input.catchUpMaxRounds,
      hooks: input.hooks,
    })
    pulled += sync.pulled
    applied += sync.applied
    acked += sync.acked
    if (sync.keepaAllowed) {
      const posted = await postRepairComplete({ db, http: input.http, nowMs, merge, hooks: input.hooks })
      if (!posted.ok) return fail(db, posted.error ?? "REPAIR_COMPLETE_FAILED", { pulled, applied, acked, merge })
      return {
        ok: true,
        error: null,
        keepaCalls: 0,
        localCount: sync.localCount,
        localHash: sync.localHash,
        centralCount: sync.centralCount,
        centralHash: sync.centralHash,
        merge,
        pulled,
        applied,
        acked,
        requestId: getWorkerState(db, "repair_request_id"),
      }
    }

    const priorPhase = bootstrapPhase(db)
    try {
      const snap = await downloadSnapshotToStaging({
        db,
        http: input.http,
        pageSize: input.pageSize,
        nowMs,
        keepPhase: true,
      })
      void snap
      await input.hooks?.onProgress?.({
        syncState: "REPAIRING_REGISTRY",
        stagingCount: stagingCount(db),
      })
    } catch (e) {
      clearStaging(db)
      setBootstrapPhase(db, priorPhase)
      throw e
    }

    input.hooks?.beforeMergeCommit?.()
    db.exec("BEGIN")
    try {
      merge = mergeStagingIntoRegistry(db, nowMs, { inTransaction: true })
      setWorkerState(db, "repair_merged", "1")
      db.exec("COMMIT")
    } catch (e) {
      db.exec("ROLLBACK")
      clearStaging(db)
      throw e
    }
    input.hooks?.afterMergeCommit?.()

    const after = await catchUpLifecycleThenReconcile({
      db,
      http: input.http,
      nowMs,
      catchUpMaxRounds: input.catchUpMaxRounds,
      hooks: input.hooks,
    })
    pulled += after.pulled
    applied += after.applied
    acked += after.acked
    if (!after.keepaAllowed) {
      return fail(db, after.error ?? "SYNC_RECONCILE_MISMATCH", { pulled, applied, acked, merge })
    }
    if (pendingAckCount(db) > 0) return fail(db, "PENDING_ACK", { pulled, applied, acked, merge })
    const posted = await postRepairComplete({ db, http: input.http, nowMs, merge, hooks: input.hooks })
    if (!posted.ok) return fail(db, posted.error ?? "REPAIR_COMPLETE_FAILED", { pulled, applied, acked, merge })
    const local = localReconcileManifest(db)
    return {
      ok: true,
      error: null,
      keepaCalls: 0,
      localCount: local.uniqueAsins,
      localHash: local.hash,
      centralCount: after.centralCount,
      centralHash: after.centralHash,
      merge,
      pulled,
      applied,
      acked,
      requestId: getWorkerState(db, "repair_request_id"),
    }
  } catch (e) {
    if (e instanceof CrashSimError) throw e
    const msg = e instanceof BootstrapError ? e.message : e instanceof Error ? e.message : String(e)
    clearStaging(db)
    return fail(db, msg, { pulled, applied, acked, merge })
  }
}
