import type { DatabaseSync } from "node:sqlite"
import { bootstrapPhase, pendingAckCount, sqliteIntegrityOk } from "./keepaLocalDb"
import { collectorLockHeldByThisProcess } from "./keepaCollectorLock"
import { catchUpLifecycleThenReconcile, type EventSyncHooks } from "./keepaCollectorEventSync"
import { runCollectorRepair, type RepairResult } from "./keepaCollectorRepair"
import type { CollectorHttp } from "./keepaCollectorBootstrap"

export type AutoRepairCollectorCfg = {
  runMode: string | null
  catchUpMaxRounds: number
  bootstrapPageSize: number
  heartbeatMs: number
  pollMs: number
  dbPath: string
}

export const KEEPA_AUTO_REPAIR_BACKOFF_MS = 60_000
export const KEEPA_COLLECTOR_AUTO_REPAIR_BACKOFF_MS = 60_000

const AUTH_OR_FORBIDDEN = /401|403|UNAUTHORIZED|ACK_UNAUTHORIZED/
const CENTRAL_UNREACHABLE = /RECONCILE_HTTP_|EVENTS_HTTP_|SNAPSHOT_HTTP_|ACK_TIMEOUT|ACK_HTTP_|ENOTFOUND|ECONN|ETIMEDOUT|FETCH_FAILED/

export type AutoRepairState = {
  inFlight: boolean
  lastFailAtMs: number
  successCount: number
  failCount: number
  lastReason: string | null
}

export function createAutoRepairState(): AutoRepairState {
  return { inFlight: false, lastFailAtMs: 0, successCount: 0, failCount: 0, lastReason: null }
}

export type AutoRepairGate = {
  repairNow: boolean
  reason: string | null
  waitMs: number
}

export function evaluateAutoRepairGate(input: {
  runMode: string | null
  phase: string
  integrityOk: boolean
  lockHeldByThisProcess: boolean
  pendingAck: number
  catchUpComplete: boolean
  centralReachable: boolean
  mismatch: boolean
  inFlight: boolean
  lastError: string | null
  nowMs: number
  lastFailAtMs: number
}): AutoRepairGate {
  if (input.runMode !== "daemon") return { repairNow: false, reason: "RUN_MODE", waitMs: 0 }
  if (input.phase !== "COMPLETE") return { repairNow: false, reason: "PHASE", waitMs: 0 }
  if (!input.integrityOk) return { repairNow: false, reason: "SQLITE_INTEGRITY", waitMs: 0 }
  if (!input.lockHeldByThisProcess) return { repairNow: false, reason: "LOCK_OTHER_PROCESS", waitMs: 0 }
  if (input.pendingAck > 0) return { repairNow: false, reason: "PENDING_ACK", waitMs: 0 }
  if (!input.catchUpComplete) return { repairNow: false, reason: "CATCHUP_INCOMPLETE", waitMs: 0 }
  if (!input.centralReachable) return { repairNow: false, reason: "CENTRAL_UNREACHABLE", waitMs: 0 }
  if (!input.mismatch) return { repairNow: false, reason: "NO_MISMATCH", waitMs: 0 }
  if (input.inFlight) return { repairNow: false, reason: "REPAIR_IN_FLIGHT", waitMs: 0 }
  const err = input.lastError ?? ""
  if (AUTH_OR_FORBIDDEN.test(err)) return { repairNow: false, reason: "AUTH_FAIL_CLOSED", waitMs: 0 }
  if (CENTRAL_UNREACHABLE.test(err) && err !== "SYNC_RECONCILE_MISMATCH") {
    return { repairNow: false, reason: "CENTRAL_UNREACHABLE", waitMs: 0 }
  }
  if (input.lastFailAtMs > 0 && input.nowMs - input.lastFailAtMs < KEEPA_AUTO_REPAIR_BACKOFF_MS) {
    return {
      repairNow: false,
      reason: "BACKOFF",
      waitMs: KEEPA_AUTO_REPAIR_BACKOFF_MS - (input.nowMs - input.lastFailAtMs),
    }
  }
  return { repairNow: true, reason: null, waitMs: 0 }
}

export type DaemonReconcileTurn = {
  keepaAllowed: boolean
  keepaStopped: boolean
  repaired: boolean
  repairAttempts: number
  keepaCalls: number
  waitMs: number
  error: string | null
  gateReason: string | null
  repair: RepairResult | null
  extraCatchUp: boolean
}

export async function reconcileThenMaybeAutoRepair(input: {
  cfg: AutoRepairCollectorCfg
  db: DatabaseSync
  http: CollectorHttp
  auto: AutoRepairState
  nowMs?: number
  lockHeldByThisProcess?: boolean
  hooks?: EventSyncHooks
}): Promise<DaemonReconcileTurn> {
  const nowMs = input.nowMs ?? Date.now()
  const empty = (extra: Partial<DaemonReconcileTurn>): DaemonReconcileTurn => ({
    keepaAllowed: false,
    keepaStopped: false,
    repaired: false,
    repairAttempts: 0,
    keepaCalls: 0,
    waitMs: 0,
    error: null,
    gateReason: null,
    repair: null,
    extraCatchUp: false,
    ...extra,
  })

  let sync = await catchUpLifecycleThenReconcile({
    db: input.db,
    http: input.http,
    nowMs,
    catchUpMaxRounds: input.cfg.catchUpMaxRounds,
    hooks: input.hooks,
  })
  let extraCatchUp = false
  if (!sync.keepaAllowed && sync.error === "SYNC_RECONCILE_MISMATCH") {
    extraCatchUp = true
    sync = await catchUpLifecycleThenReconcile({
      db: input.db,
      http: input.http,
      nowMs,
      catchUpMaxRounds: input.cfg.catchUpMaxRounds,
      hooks: input.hooks,
    })
  }
  if (sync.keepaAllowed) {
    return empty({ keepaAllowed: true, extraCatchUp, error: null })
  }

  const err = sync.error ?? "SYNC_RECONCILE_MISMATCH"
  if (AUTH_OR_FORBIDDEN.test(err)) {
    return empty({ keepaStopped: true, error: err, extraCatchUp, waitMs: input.cfg.heartbeatMs })
  }

  const mismatch = err === "SYNC_RECONCILE_MISMATCH"
  const catchUpComplete = err !== "CATCHUP_LIMIT_EXCEEDED"
  const centralReachable =
    typeof sync.centralHash === "string" &&
    sync.centralHash.length >= 32 &&
    sync.centralCount != null &&
    Number.isFinite(sync.centralCount) &&
    !CENTRAL_UNREACHABLE.test(err)

  const gate = evaluateAutoRepairGate({
    runMode: input.cfg.runMode,
    phase: bootstrapPhase(input.db),
    integrityOk: sqliteIntegrityOk(input.db),
    lockHeldByThisProcess: input.lockHeldByThisProcess ?? collectorLockHeldByThisProcess(input.cfg.dbPath),
    pendingAck: pendingAckCount(input.db),
    catchUpComplete,
    centralReachable,
    mismatch,
    inFlight: input.auto.inFlight,
    lastError: err,
    nowMs,
    lastFailAtMs: input.auto.lastFailAtMs,
  })
  input.auto.lastReason = gate.reason
  if (!gate.repairNow) {
    return empty({
      error: err,
      extraCatchUp,
      gateReason: gate.reason,
      waitMs: gate.waitMs > 0 ? gate.waitMs : Math.min(input.cfg.pollMs, KEEPA_AUTO_REPAIR_BACKOFF_MS),
    })
  }

  input.auto.inFlight = true
  try {
    const repair = await runCollectorRepair({
      db: input.db,
      http: input.http,
      pageSize: input.cfg.bootstrapPageSize,
      nowMs,
      catchUpMaxRounds: input.cfg.catchUpMaxRounds,
      hooks: input.hooks,
      forceSnapshotMerge: true,
    })
    if (repair.ok && repair.keepaCalls === 0) {
      input.auto.successCount++
      input.auto.lastFailAtMs = 0
      input.auto.lastReason = null
      return empty({
        keepaAllowed: true,
        repaired: true,
        repairAttempts: 1,
        extraCatchUp,
        repair,
        error: null,
      })
    }
    input.auto.failCount++
    input.auto.lastFailAtMs = nowMs
    input.auto.lastReason = repair.error
    return empty({
      repaired: false,
      repairAttempts: 1,
      extraCatchUp,
      repair,
      error: repair.error,
      gateReason: repair.error,
      waitMs: KEEPA_AUTO_REPAIR_BACKOFF_MS,
    })
  } finally {
    input.auto.inFlight = false
  }
}
