import { query } from "../../db/client"
import type { KeepaApiResponse } from "../keepa/keepaTypes"

export const DEFAULT_REFILL_RATE_PER_MINUTE = 20
export const DEFAULT_BUCKET_CAPACITY = 1200
export const TOKEN_RESERVE = 100
const MIN_TOKEN_WAIT_MINUTES = 5
const MAX_TOKEN_WAIT_MINUTES = 60
/** When tokens unknown, block scheduling very large scans until a Keepa response refreshes state. */
const MAX_ESTIMATED_WHEN_TOKENS_UNKNOWN = 50

let staleRecoveredLastRun = 0

export function getTokenReserve(): number {
  return TOKEN_RESERVE
}

export function getStaleRecoveredLastRun(): number {
  return staleRecoveredLastRun
}

export function extractKeepaTokensLeft(resp: KeepaApiResponse | null | undefined): number | null {
  if (!resp || typeof resp !== "object") return null
  const raw =
    (resp as { tokensLeft?: unknown }).tokensLeft ??
    (resp as { tokens_left?: unknown }).tokens_left
  if (raw == null) return null
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10)
  return Number.isFinite(n) ? Math.floor(n) : null
}

export function computeEffectiveTokens(input: {
  tokensLeftRaw: number
  tokensUpdatedAt: string | Date | null
  refillRatePerMinute: number
  bucketCapacity: number
  now?: Date
}): number {
  const raw = Math.max(0, Math.floor(input.tokensLeftRaw))
  const rate = Math.max(0, input.refillRatePerMinute)
  const cap = Math.max(raw, input.bucketCapacity)
  if (!input.tokensUpdatedAt) return Math.min(cap, raw)

  const updatedMs = new Date(input.tokensUpdatedAt).getTime()
  if (!Number.isFinite(updatedMs)) return Math.min(cap, raw)

  const nowMs = (input.now ?? new Date()).getTime()
  const minutesSince = Math.max(0, (nowMs - updatedMs) / 60_000)
  const refilled = raw + Math.floor(minutesSince * rate)
  return Math.min(cap, refilled)
}

export function computeTokenWaitMinutes(
  missingTokens: number,
  refillRatePerMinute: number
): number {
  if (missingTokens <= 0) return MIN_TOKEN_WAIT_MINUTES
  const rate = Math.max(1, refillRatePerMinute)
  const wait = Math.ceil(missingTokens / rate)
  return Math.min(MAX_TOKEN_WAIT_MINUTES, Math.max(MIN_TOKEN_WAIT_MINUTES, wait))
}

export type KeepaTokenSnapshot = {
  tokensLeftRaw: number | null
  tokensLeftEffective: number | null
  tokensLeft: number | null
  tokensUpdatedAt: string | null
  refillRatePerMinute: number
  bucketCapacity: number
  reserveTokens: number
  tokensKnown: boolean
}

export async function getKeepaTokenSnapshot(workspaceId: string): Promise<KeepaTokenSnapshot> {
  const reserveTokens = TOKEN_RESERVE
  const defaults = {
    refillRatePerMinute: DEFAULT_REFILL_RATE_PER_MINUTE,
    bucketCapacity: DEFAULT_BUCKET_CAPACITY,
  }

  try {
    const res = await query<{
      tokens_left: number | null
      tokens_updated_at: string | null
      refill_rate_per_minute: number | null
      bucket_capacity: number | null
    }>(
      `SELECT tokens_left,
              tokens_updated_at::text AS tokens_updated_at,
              refill_rate_per_minute,
              bucket_capacity
       FROM keepa_token_state WHERE workspace_id = $1::uuid LIMIT 1`,
      [workspaceId]
    )
    const row = res.rows[0]
    const tokensLeftRaw = row?.tokens_left ?? null
    const tokensKnown = tokensLeftRaw != null
    const refillRatePerMinute =
      row?.refill_rate_per_minute != null && row.refill_rate_per_minute > 0
        ? row.refill_rate_per_minute
        : defaults.refillRatePerMinute
    const bucketCapacity =
      row?.bucket_capacity != null && row.bucket_capacity > 0
        ? row.bucket_capacity
        : defaults.bucketCapacity

    const tokensLeftEffective =
      tokensKnown && tokensLeftRaw != null
        ? computeEffectiveTokens({
            tokensLeftRaw,
            tokensUpdatedAt: row?.tokens_updated_at ?? null,
            refillRatePerMinute,
            bucketCapacity,
          })
        : null

    return {
      tokensLeftRaw,
      tokensLeftEffective,
      tokensLeft: tokensLeftEffective,
      tokensUpdatedAt: row?.tokens_updated_at ?? null,
      refillRatePerMinute,
      bucketCapacity,
      reserveTokens,
      tokensKnown,
    }
  } catch {
    return {
      tokensLeftRaw: null,
      tokensLeftEffective: null,
      tokensLeft: null,
      tokensUpdatedAt: null,
      refillRatePerMinute: defaults.refillRatePerMinute,
      bucketCapacity: defaults.bucketCapacity,
      reserveTokens,
      tokensKnown: false,
    }
  }
}

/** @deprecated Use getKeepaTokenSnapshot */
export async function getTokensLeft(workspaceId: string): Promise<{
  tokensLeft: number | null
  tokensUpdatedAt: string | null
  tokensKnown: boolean
}> {
  const snap = await getKeepaTokenSnapshot(workspaceId)
  return {
    tokensLeft: snap.tokensLeftEffective,
    tokensUpdatedAt: snap.tokensUpdatedAt,
    tokensKnown: snap.tokensKnown,
  }
}

export async function recordTokensLeft(
  workspaceId: string,
  tokensLeft: number | undefined | null
): Promise<void> {
  if (tokensLeft == null || !Number.isFinite(tokensLeft)) return
  try {
    await query(
      `INSERT INTO keepa_token_state (
         workspace_id, tokens_left, tokens_updated_at,
         refill_rate_per_minute, bucket_capacity, updated_at
       )
       VALUES ($1::uuid, $2::integer, NOW(), $3::integer, $4::integer, NOW())
       ON CONFLICT (workspace_id) DO UPDATE SET
         tokens_left = EXCLUDED.tokens_left,
         tokens_updated_at = NOW(),
         updated_at = NOW()`,
      [
        workspaceId,
        Math.floor(tokensLeft),
        DEFAULT_REFILL_RATE_PER_MINUTE,
        DEFAULT_BUCKET_CAPACITY,
      ]
    )
  } catch (e) {
    console.warn(
      "[KeepaTokenGuard] recordTokensLeft failed (run migration 026?):",
      e instanceof Error ? e.message : String(e)
    )
  }
}

export async function recordTokensFromKeepaResponse(
  workspaceId: string,
  resp: KeepaApiResponse | null | undefined
): Promise<void> {
  const tokens = extractKeepaTokensLeft(resp)
  if (tokens != null) {
    await recordTokensLeft(workspaceId, tokens)
  }
}

export async function canSpendTokens(
  workspaceId: string,
  estimatedCost: number
): Promise<{
  allowed: boolean
  reason: string
  tokensLeft: number | null
  tokensLeftRaw: number | null
  tokensLeftEffective: number | null
  required: number
  waitMinutes?: number
}> {
  const snap = await getKeepaTokenSnapshot(workspaceId)
  const cost = Math.max(1, Math.ceil(estimatedCost))
  const required = cost + TOKEN_RESERVE

  if (!snap.tokensKnown || snap.tokensLeftRaw == null) {
    if (cost > MAX_ESTIMATED_WHEN_TOKENS_UNKNOWN) {
      return {
        allowed: false,
        reason: `unknown_tokens_conservative max=${MAX_ESTIMATED_WHEN_TOKENS_UNKNOWN} requested=${cost}`,
        tokensLeft: null,
        tokensLeftRaw: null,
        tokensLeftEffective: null,
        required,
      }
    }
    return {
      allowed: true,
      reason: "conservative_mode_unknown_tokens",
      tokensLeft: null,
      tokensLeftRaw: null,
      tokensLeftEffective: null,
      required,
    }
  }

  const effective = snap.tokensLeftEffective ?? snap.tokensLeftRaw
  if (effective >= required) {
    return {
      allowed: true,
      reason: "ok",
      tokensLeft: effective,
      tokensLeftRaw: snap.tokensLeftRaw,
      tokensLeftEffective: effective,
      required,
    }
  }

  const missing = required - effective
  const waitMinutes = computeTokenWaitMinutes(missing, snap.refillRatePerMinute)

  return {
    allowed: false,
    reason: `Waiting for Keepa tokens: need ${required}, available ${effective}`,
    tokensLeft: effective,
    tokensLeftRaw: snap.tokensLeftRaw,
    tokensLeftEffective: effective,
    required,
    waitMinutes,
  }
}

let recoveryColumnsKnown: boolean | null = null

async function hasRecoveryColumns(): Promise<boolean> {
  if (recoveryColumnsKnown != null) return recoveryColumnsKnown
  try {
    const res = await query<{ ok: number }>(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_name = 'stock_guard_scan_jobs' AND column_name = 'retry_count'
       LIMIT 1`
    )
    recoveryColumnsKnown = (res.rows[0]?.ok ?? 0) === 1
  } catch {
    recoveryColumnsKnown = false
  }
  return recoveryColumnsKnown
}

const STALE_JOB_CONNECTED_STORES = `j.store_id IN (
  SELECT s.id FROM stores s
  INNER JOIN ebay_accounts ea
    ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id
  WHERE s.workspace_id = $1::uuid AND s.status = 'active'
)`

export async function recoverStaleStockGuardJobs(workspaceId: string): Promise<number> {
  try {
    const withRetry = await hasRecoveryColumns()
    let recovered = 0

    if (withRetry) {
      await query(
        `UPDATE stock_guard_scan_jobs j
         SET status = 'failed',
             error_message = 'Failed after repeated stale recoveries',
             completed_at = NOW(),
             started_at = NULL,
             updated_at = NOW()
         WHERE j.workspace_id = $1::uuid
           AND j.status = 'running'
           AND j.started_at < NOW() - INTERVAL '30 minutes'
           AND COALESCE(j.retry_count, 0) >= 3
           AND ${STALE_JOB_CONNECTED_STORES}`,
        [workspaceId]
      )

      const res = await query(
        `UPDATE stock_guard_scan_jobs j
         SET status = 'queued',
             started_at = NULL,
             error_message = 'Recovered stale running job after backend restart',
             scheduled_for = NOW() + INTERVAL '1 minute',
             retry_count = COALESCE(j.retry_count, 0) + 1,
             last_recovered_at = NOW(),
             updated_at = NOW()
         WHERE j.workspace_id = $1::uuid
           AND j.status = 'running'
           AND j.started_at < NOW() - INTERVAL '30 minutes'
           AND COALESCE(j.retry_count, 0) < 3
           AND ${STALE_JOB_CONNECTED_STORES}`,
        [workspaceId]
      )
      recovered = res.rowCount ?? 0
    } else {
      const res = await query(
        `UPDATE stock_guard_scan_jobs j
         SET status = 'queued',
             started_at = NULL,
             error_message = 'Recovered stale running job after backend restart',
             scheduled_for = NOW() + INTERVAL '1 minute',
             updated_at = NOW()
         WHERE j.workspace_id = $1::uuid
           AND j.status = 'running'
           AND j.started_at < NOW() - INTERVAL '30 minutes'
           AND ${STALE_JOB_CONNECTED_STORES}`,
        [workspaceId]
      )
      recovered = res.rowCount ?? 0
    }

    staleRecoveredLastRun = recovered
    if (recovered > 0) {
      console.log(`[StockGuard] recoverStaleStockGuardJobs recovered=${recovered}`)
    }
    return recovered
  } catch (e) {
    console.warn(
      "[StockGuard] recoverStaleStockGuardJobs failed:",
      e instanceof Error ? e.message : String(e)
    )
    staleRecoveredLastRun = 0
    return 0
  }
}

/** @deprecated Use recoverStaleStockGuardJobs */
export async function recoverStaleRunningJobs(workspaceId: string): Promise<number> {
  return recoverStaleStockGuardJobs(workspaceId)
}
