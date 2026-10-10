import { acquireClient, isConnectionError, query } from "../../db/client"
import type { PoolClient } from "pg"
import type { ListingPriorityRank } from "./globalKeepaTypes"
import {
  GLOBAL_KEEPA_ACTIVE_ASINS_SQL,
  GLOBAL_KEEPA_ACTIVE_ASIN_IDS_SQL,
  GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE,
  GLOBAL_KEEPA_ACTIVE_PRIORITY_SQL,
} from "./globalKeepaEligibility"

export type ActiveGlobalAsinRow = {
  globalAsinId: number
  keepaDomain: number
  asin: string
  priority: ListingPriorityRank
  lastCheckedAt: Date | null
  nextCheckAt: Date | null
  consumerCount: number
}

function mapActiveRow(r: {
  global_asin_id: string | number
  keepa_domain: string | number
  asin: string
  priority: string | number | null
  last_checked_at: Date | string | null
  next_check_at: Date | string | null
  consumer_count: string | number
}): ActiveGlobalAsinRow {
  const p = Number(r.priority)
  return {
    globalAsinId: Number(r.global_asin_id),
    keepaDomain: Number(r.keepa_domain),
    asin: r.asin,
    priority: p === 0 || p === 1 ? p : 2,
    lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at) : null,
    nextCheckAt: r.next_check_at ? new Date(r.next_check_at) : null,
    consumerCount: Number(r.consumer_count) || 0,
  }
}

/** DB-side unique active ASIN set. Optional limit avoids loading the full catalog into memory. */
export async function getActiveGlobalAsins(options?: {
  limit?: number
  offset?: number
}): Promise<ActiveGlobalAsinRow[]> {
  const limit = options?.limit
  const offset = options?.offset ?? 0
  const sql =
    limit != null
      ? `${GLOBAL_KEEPA_ACTIVE_ASINS_SQL} ORDER BY g.id ASC LIMIT $1::int OFFSET $2::int`
      : `${GLOBAL_KEEPA_ACTIVE_ASINS_SQL} ORDER BY g.id ASC`
  const res = await query(sql, limit != null ? [limit, offset] : [])
  return res.rows.map(row => mapActiveRow(row as Parameters<typeof mapActiveRow>[0]))
}

export async function countActiveGlobalAsins(): Promise<{
  activeUniqueAsinCount: number
  activeConsumerCount: number
  soldAsins: number
  clickedAsins: number
  normalAsins: number
}> {
  const res = await query<{
    unique_asins: string
    consumers: string
    sold: string
    clicked: string
    normal: string
  }>(
    `SELECT COUNT(*)::text AS unique_asins,
            COALESCE(SUM(consumer_count),0)::text AS consumers,
            SUM(CASE WHEN priority = 0 THEN 1 ELSE 0 END)::text AS sold,
            SUM(CASE WHEN priority = 1 THEN 1 ELSE 0 END)::text AS clicked,
            SUM(CASE WHEN priority = 2 THEN 1 ELSE 0 END)::text AS normal
     FROM (${GLOBAL_KEEPA_ACTIVE_ASINS_SQL}) active`
  )
  const r = res.rows[0]
  return {
    activeUniqueAsinCount: parseInt(r?.unique_asins ?? "0", 10) || 0,
    activeConsumerCount: parseInt(r?.consumers ?? "0", 10) || 0,
    soldAsins: parseInt(r?.sold ?? "0", 10) || 0,
    clickedAsins: parseInt(r?.clicked ?? "0", 10) || 0,
    normalAsins: parseInt(r?.normal ?? "0", 10) || 0,
  }
}

export async function syncPlannerStateFromActiveConsumers(): Promise<number> {
  const res = await query(
    `INSERT INTO global_keepa_planner_state (global_asin_id, priority, created_at, updated_at)
     SELECT g.id,
            ${GLOBAL_KEEPA_ACTIVE_PRIORITY_SQL},
            NOW(), NOW()
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     WHERE ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE}
     GROUP BY g.id
     ON CONFLICT (global_asin_id) DO UPDATE SET
       priority = EXCLUDED.priority,
       updated_at = NOW()`
  )
  return res.rowCount ?? 0
}

export type ClaimedPlannerAsin = {
  globalAsinId: number
  keepaDomain: number
  asin: string
  priority: ListingPriorityRank
  failureCount: number
  lastSuccessAt: Date | null
  lastCheckedAt: Date | null
  nextCheckAt: Date | null
}

export async function claimDuePlannerAsins(input: {
  domain: number
  limit: number
  workerId: string
  leaseSeconds: number
  hardMaxCheckAgeHours: number
  client?: PoolClient
}): Promise<ClaimedPlannerAsin[]> {
  const limit = Math.max(0, Math.min(100, input.limit))
  if (limit <= 0) return []
  const sql = `WITH eligible AS (
       ${GLOBAL_KEEPA_ACTIVE_ASIN_IDS_SQL}
     ),
     picked AS (
       SELECT p.global_asin_id
       FROM global_keepa_planner_state p
       JOIN eligible e ON e.global_asin_id = p.global_asin_id
       JOIN global_amazon_asins g ON g.id = p.global_asin_id
       WHERE g.keepa_domain = $1::integer
         AND (p.claimed_until IS NULL OR p.claimed_until < NOW())
         AND (
           p.next_check_at IS NULL
           OR p.next_check_at <= NOW()
           OR p.last_success_at IS NULL
           OR p.last_success_at <= NOW() - make_interval(hours => $4::int)
         )
       ORDER BY
         CASE
           WHEN p.last_success_at IS NULL
             OR p.last_success_at <= NOW() - make_interval(hours => $4::int)
           THEN 0 ELSE 1
         END,
         p.last_success_at ASC NULLS FIRST,
         p.priority ASC NULLS LAST,
         p.next_check_at ASC NULLS FIRST,
         p.global_asin_id ASC
       LIMIT $2::int
       FOR UPDATE OF p SKIP LOCKED
     )
     UPDATE global_keepa_planner_state p
     SET claimed_until = NOW() + make_interval(secs => $3::int),
         claimed_by = $5::text,
         last_attempt_at = NOW(),
         updated_at = NOW()
     FROM picked
     JOIN global_amazon_asins g ON g.id = picked.global_asin_id
     WHERE p.global_asin_id = picked.global_asin_id
     RETURNING p.global_asin_id::text,
               g.keepa_domain,
               g.asin,
               p.priority,
               p.failure_count,
               p.last_success_at,
               p.last_checked_at,
               p.next_check_at`
  const params = [input.domain, limit, input.leaseSeconds, input.hardMaxCheckAgeHours, input.workerId]
  type ClaimRow = {
    global_asin_id: string
    keepa_domain: number
    asin: string
    priority: number | null
    failure_count: number | null
    last_success_at: Date | null
    last_checked_at: Date | null
    next_check_at: Date | null
  }
  const res = input.client
    ? await input.client.query(sql, params)
    : await query<ClaimRow>(sql, params)
  return (res.rows as ClaimRow[]).map(r => ({
    globalAsinId: Number(r.global_asin_id),
    keepaDomain: Number(r.keepa_domain),
    asin: r.asin,
    priority: r.priority === 0 || r.priority === 1 ? r.priority : 2,
    failureCount: Math.max(0, Number(r.failure_count) || 0),
    lastSuccessAt: r.last_success_at ? new Date(r.last_success_at) : null,
    lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at) : null,
    nextCheckAt: r.next_check_at ? new Date(r.next_check_at) : null,
  }))
}

export async function countDuePlannerBuckets(hardMaxCheckAgeHours: number): Promise<{
  dueUniqueAsins: number
  overdueUniqueAsins: number
  soldDue: number
  clickedDue: number
  normalDue: number
}> {
  const res = await query<{
    due: string
    overdue: string
    sold_due: string
    clicked_due: string
    normal_due: string
  }>(
    `WITH eligible AS (${GLOBAL_KEEPA_ACTIVE_ASIN_IDS_SQL})
     SELECT
       COUNT(*)::text AS due,
       SUM(CASE WHEN p.last_success_at IS NULL
                 OR p.last_success_at <= NOW() - make_interval(hours => $1::int)
                THEN 1 ELSE 0 END)::text AS overdue,
       SUM(CASE WHEN p.priority = 0 AND (
                  p.next_check_at IS NULL OR p.next_check_at <= NOW()
                  OR p.last_success_at IS NULL
                  OR p.last_success_at <= NOW() - make_interval(hours => $1::int)
                ) THEN 1 ELSE 0 END)::text AS sold_due,
       SUM(CASE WHEN p.priority = 1 AND (
                  p.next_check_at IS NULL OR p.next_check_at <= NOW()
                  OR p.last_success_at IS NULL
                  OR p.last_success_at <= NOW() - make_interval(hours => $1::int)
                ) THEN 1 ELSE 0 END)::text AS clicked_due,
       SUM(CASE WHEN COALESCE(p.priority, 2) = 2 AND (
                  p.next_check_at IS NULL OR p.next_check_at <= NOW()
                  OR p.last_success_at IS NULL
                  OR p.last_success_at <= NOW() - make_interval(hours => $1::int)
                ) THEN 1 ELSE 0 END)::text AS normal_due
     FROM global_keepa_planner_state p
     JOIN eligible e ON e.global_asin_id = p.global_asin_id
     WHERE p.next_check_at IS NULL
        OR p.next_check_at <= NOW()
        OR p.last_success_at IS NULL
        OR p.last_success_at <= NOW() - make_interval(hours => $1::int)`,
    [hardMaxCheckAgeHours]
  )
  const r = res.rows[0]
  return {
    dueUniqueAsins: parseInt(r?.due ?? "0", 10) || 0,
    overdueUniqueAsins: parseInt(r?.overdue ?? "0", 10) || 0,
    soldDue: parseInt(r?.sold_due ?? "0", 10) || 0,
    clickedDue: parseInt(r?.clicked_due ?? "0", 10) || 0,
    normalDue: parseInt(r?.normal_due ?? "0", 10) || 0,
  }
}

export async function markGlobalAsinImmediatelyDue(
  globalAsinId: number,
  client?: PoolClient
): Promise<void> {
  const sql = `INSERT INTO global_keepa_planner_state (
         global_asin_id, next_check_at, priority, created_at, updated_at
       ) VALUES ($1::bigint, NOW(), 2, NOW(), NOW())
       ON CONFLICT (global_asin_id) DO UPDATE SET
         next_check_at = NOW(),
         updated_at = NOW()`
  if (client) await client.query(sql, [globalAsinId])
  else await query(sql, [globalAsinId])
}

export async function markPlannerSuccess(input: {
  globalAsinId: number
  nextCheckAt: Date
  checkedAt: Date
}): Promise<void> {
  await query(
    `UPDATE global_keepa_planner_state
     SET last_checked_at = $2::timestamptz,
         last_success_at = $2::timestamptz,
         next_check_at = $3::timestamptz,
         failure_count = 0,
         last_failure_code = NULL,
         claimed_until = NULL,
         claimed_by = NULL,
         updated_at = NOW()
     WHERE global_asin_id = $1::bigint
       AND (last_success_at IS NULL OR last_success_at <= $2::timestamptz)`,
    [input.globalAsinId, input.checkedAt, input.nextCheckAt]
  )
}

export async function markPlannerFailure(input: {
  globalAsinId: number
  nextCheckAt: Date
  code: string
}): Promise<void> {
  await query(
    `UPDATE global_keepa_planner_state
     SET last_checked_at = NOW(),
         next_check_at = $2::timestamptz,
         failure_count = failure_count + 1,
         last_failure_code = $3::text,
         claimed_until = NULL,
         claimed_by = NULL,
         updated_at = NOW()
     WHERE global_asin_id = $1::bigint`,
    [input.globalAsinId, input.nextCheckAt, input.code.slice(0, 80)]
  )
}

export const GLOBAL_KEEPA_PLANNER_LOCK_KEY = 87200155

export async function withPlannerTickLock<T>(fn: (client: PoolClient) => Promise<T>): Promise<T | "locked"> {
  const client = await acquireClient("globalKeepaPlannerLock")
  let failure: unknown = null
  let locked = false
  try {
    const got = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock($1::bigint) AS locked`,
      [GLOBAL_KEEPA_PLANNER_LOCK_KEY]
    )
    if (got.rows[0]?.locked !== true) return "locked"
    locked = true
    return await fn(client)
  } catch (error) {
    failure = error
    throw error
  } finally {
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [GLOBAL_KEEPA_PLANNER_LOCK_KEY])
      } catch (unlockError) {
        if (!failure) {
          failure = unlockError
          throw unlockError
        }
      }
    }
    client.release(
      isConnectionError(failure)
        ? (failure instanceof Error ? failure : new Error(String(failure)))
        : undefined
    )
  }
}
