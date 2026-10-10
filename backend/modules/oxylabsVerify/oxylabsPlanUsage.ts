import type { PoolClient } from "pg"
import { query } from "../../db/client"
import {
  oxylabsBillingCycleWindow,
  oxylabsCycleAllowsNewReservation,
  oxylabsCycleRemaining,
} from "./oxylabsBillingCycle"
import { loadOxylabsVerifyConfig, type OxylabsVerifyConfig } from "./oxylabsVerifyConfig"
import { OXYLABS_ACTIVE_JOB_STATUSES, oxylabsFeederRemaining } from "./oxylabsVerifyQueueCap"
import { countOxylabsCallReservations } from "./oxylabsVerifyReservations"

type Q = { query: PoolClient["query"] }

function asQ(client?: Q): Q {
  return client ?? { query: ((sql: string, params?: unknown[]) => query(sql, params as never)) as PoolClient["query"] }
}

export type OxylabsPlanUsage = {
  planMode: "paid" | "canary"
  monthlyLimit: number
  cycleStart: string | null
  cycleEnd: string | null
  cycleReserved: number
  cycleSuccessful: number
  remaining: number
  lifetimeReserved: number
  lifetimeSuccessful: number
  unreservedActivePrimaryJobs: number
  pending: number
  allowsNewReservation: boolean
  lastProductAt: string | null
  lastError: string | null
  workerStatus: string | null
}

export async function countOxylabsReservationsInWindow(
  start: Date,
  end: Date,
  client?: Q
): Promise<number> {
  const res = await asQ(client).query(`SELECT COUNT(*)::text AS c FROM oxylabs_verify_call_reservations
     WHERE reserved_at >= $1::timestamptz AND reserved_at < $2::timestamptz`, [start.toISOString(), end.toISOString()])
  return parseInt(String((res as { rows: Array<{ c: string }> }).rows[0]?.c ?? "0"), 10) || 0
}

export async function countUnreservedActivePrimaryJobs(client?: Q): Promise<number> {
  const res = await asQ(client).query(
    `SELECT COUNT(*)::text AS c
     FROM amazon_scan_jobs j
     WHERE j.kind = 'OXYLABS_PRODUCT_PRIMARY'
       AND j.status = ANY($1::text[])
       AND NOT EXISTS (
         SELECT 1 FROM oxylabs_verify_call_reservations r WHERE r.job_id = j.id
       )`,
    [OXYLABS_ACTIVE_JOB_STATUSES]
  )
  return parseInt(String((res as { rows: Array<{ c: string }> }).rows[0]?.c ?? "0"), 10) || 0
}

export function oxylabsEnqueueRemainingForConfig(
  cfg: OxylabsVerifyConfig,
  input: { cycleReserved: number; lifetimeReserved: number; unreserved: number }
): number {
  if (cfg.planMode === "paid" && cfg.billingCycleAnchorAt) {
    return oxylabsCycleRemaining({
      monthlyLimit: cfg.monthlyResultLimit,
      currentCycleReservations: input.cycleReserved,
      unreservedActivePrimaryJobs: input.unreserved,
    })
  }
  return oxylabsFeederRemaining({
    canaryMax: cfg.canaryMaxSuccessResults,
    uniqueReservationCount: input.lifetimeReserved,
    unreservedActiveOxylabsJobCount: input.unreserved,
  })
}

export async function loadOxylabsPlanUsage(client?: Q): Promise<OxylabsPlanUsage> {
  const cfg = loadOxylabsVerifyConfig()
  const lifetimeReserved = await countOxylabsCallReservations(client)
  const lifetimeSuccessfulRes = await asQ(client).query(
    `SELECT success_result_count FROM oxylabs_verify_canary_state WHERE id = 1`
  )
  const lifetimeSuccessful =
    Number((lifetimeSuccessfulRes as { rows: Array<{ success_result_count: number }> }).rows[0]?.success_result_count ?? 0) ||
    0
  const unreserved = await countUnreservedActivePrimaryJobs(client)
  const pendingRes = await asQ(client).query(
    `SELECT COUNT(*)::text AS c FROM amazon_scan_jobs WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND status = 'PENDING'`
  )
  const pending = parseInt(String((pendingRes as { rows: Array<{ c: string }> }).rows[0]?.c ?? "0"), 10) || 0
  const lastProduct = await asQ(client).query(
    `SELECT MAX(completed_at) AS t FROM amazon_scan_jobs WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND status = 'COMPLETED'`
  )
  const lastErr = await asQ(client).query(
    `SELECT last_error, status FROM amazon_scan_worker_heartbeat WHERE worker_id = 'oxylabs-product-primary-A'`
  )
  const hb = (lastErr as { rows: Array<{ last_error: string | null; status: string }> }).rows[0]
  let cycleStart: Date | null = null
  let cycleEnd: Date | null = null
  let cycleReserved = 0
  let cycleSuccessful = 0
  if (cfg.planMode === "paid" && cfg.billingCycleAnchorAt) {
    const w = oxylabsBillingCycleWindow(cfg.billingCycleAnchorAt, new Date())
    cycleStart = w.start
    cycleEnd = w.end
    cycleReserved = await countOxylabsReservationsInWindow(w.start, w.end, client)
    const ok = await asQ(client).query(
      `SELECT COUNT(*)::text AS c
       FROM oxylabs_verify_call_reservations r
       JOIN amazon_scan_jobs j ON j.id = r.job_id
       WHERE r.reserved_at >= $1::timestamptz AND r.reserved_at < $2::timestamptz
         AND j.status = 'COMPLETED' AND j.kind = 'OXYLABS_PRODUCT_PRIMARY'`,
      [w.start.toISOString(), w.end.toISOString()]
    )
    cycleSuccessful = parseInt(String((ok as { rows: Array<{ c: string }> }).rows[0]?.c ?? "0"), 10) || 0
  }
  const remaining = oxylabsEnqueueRemainingForConfig(cfg, {
    cycleReserved,
    lifetimeReserved,
    unreserved,
  })
  const allowsNewReservation =
    cfg.planMode === "paid" && cfg.billingCycleAnchorAt
      ? oxylabsCycleAllowsNewReservation({
          monthlyLimit: cfg.monthlyResultLimit,
          currentCycleReservations: cycleReserved,
        })
      : lifetimeReserved < cfg.canaryMaxSuccessResults
  return {
    planMode: cfg.planMode,
    monthlyLimit: cfg.planMode === "paid" ? cfg.monthlyResultLimit : cfg.canaryMaxSuccessResults,
    cycleStart: cycleStart ? cycleStart.toISOString() : null,
    cycleEnd: cycleEnd ? cycleEnd.toISOString() : null,
    cycleReserved,
    cycleSuccessful,
    remaining,
    lifetimeReserved,
    lifetimeSuccessful,
    unreservedActivePrimaryJobs: unreserved,
    pending,
    allowsNewReservation,
    lastProductAt: (lastProduct as { rows: Array<{ t: Date | null }> }).rows[0]?.t
      ? new Date(String((lastProduct as { rows: Array<{ t: Date }> }).rows[0].t)).toISOString()
      : null,
    lastError: hb?.last_error ?? null,
    workerStatus: hb?.status ?? null,
  }
}

export async function oxylabsCanaryUsage(): Promise<{
  reserved: number
  max: number
  planMode: string
  monthlyLimit: number
  cycleStart: string | null
  cycleEnd: string | null
  cycleReserved: number
  cycleSuccessful: number
  remaining: number
  lifetimeReserved: number
  lifetimeSuccessful: number
  pending: number
  workerStatus: string | null
  lastProductAt: string | null
  lastError: string | null
}> {
  const usage = await loadOxylabsPlanUsage()
  return {
    reserved: usage.lifetimeReserved,
    max: usage.monthlyLimit,
    planMode: usage.planMode,
    monthlyLimit: usage.monthlyLimit,
    cycleStart: usage.cycleStart,
    cycleEnd: usage.cycleEnd,
    cycleReserved: usage.cycleReserved,
    cycleSuccessful: usage.cycleSuccessful,
    remaining: usage.remaining,
    lifetimeReserved: usage.lifetimeReserved,
    lifetimeSuccessful: usage.lifetimeSuccessful,
    pending: usage.pending,
    workerStatus: usage.workerStatus,
    lastProductAt: usage.lastProductAt,
    lastError: usage.lastError,
  }
}

