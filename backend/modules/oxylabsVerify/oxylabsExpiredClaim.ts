export const OXYLABS_EXPIRED_RECOVERY = "expiredRecovery"

export function oxylabsLeaseStillValid(leaseExpiresAt: Date | string | null | undefined, nowMs = Date.now()): boolean {
  if (leaseExpiresAt == null) return false
  const t = leaseExpiresAt instanceof Date ? leaseExpiresAt.getTime() : new Date(leaseExpiresAt).getTime()
  return Number.isFinite(t) && t > nowMs
}

/** WORKER_BUSY only for a still-leased CLAIMED/RUNNING job owned by this worker. */
export function oxylabsWorkerHasUnexpiredBusyJob(
  rows: Array<{ status: string; leaseExpiresAt: Date | string | null }>,
  nowMs = Date.now()
): boolean {
  return rows.some(
    r =>
      (r.status === "CLAIMED" || r.status === "RUNNING") && oxylabsLeaseStillValid(r.leaseExpiresAt, nowMs)
  )
}

export function oxylabsIsExpiredOwnedClaim(input: {
  status: string
  workerId: string | null
  requestWorkerId: string
  leaseExpiresAt: Date | string | null
  nowMs?: number
}): boolean {
  if (input.workerId !== input.requestWorkerId) return false
  if (input.status !== "CLAIMED" && input.status !== "RUNNING") return false
  return !oxylabsLeaseStillValid(input.leaseExpiresAt, input.nowMs)
}

/** Only the owning workerId may terminal-fail a CLAIMED/RUNNING Oxylabs job. */
export function mayOxylabsOwnerTerminalFail(input: {
  jobWorkerId: string | null
  requestWorkerId: string
  status: string
}): boolean {
  if (input.jobWorkerId !== input.requestWorkerId) return false
  return input.status === "CLAIMED" || input.status === "RUNNING" || input.status === "FAILED"
}
