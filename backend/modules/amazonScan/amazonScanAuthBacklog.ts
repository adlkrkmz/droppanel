import { query } from "../../db/client"

/**
 * Reassign SERVER_BROWSER_AUTH PRICE_MISSING rows to public unauthenticated recheck.
 * Does not COMPLETE or invent negatives. Spreads available_at to avoid a stampede.
 * Dry-run by default.
 */
export async function reassignAuthBacklogToPublic(input?: {
  execute?: boolean
  limit?: number
  spreadMinutes?: number
}): Promise<{ matched: number; updated: number; oldestCreated: string | null }> {
  const limit = Math.max(1, Math.min(2000, input?.limit ?? 500))
  const spread = Math.max(5, Math.min(24 * 60, input?.spreadMinutes ?? 180))
  const found = await query<{ n: string; oldest: Date | null }>(
    `SELECT COUNT(*)::text AS n, MIN(created_at) AS oldest
     FROM amazon_price_verification_tasks
     WHERE claimed_by_source = 'SERVER_BROWSER_AUTH'
       AND status IN ('PENDING','RETRYABLE','WAITING_FOR_WORKER')
       AND reason = 'PRICE_MISSING'`
  )
  const matched = parseInt(found.rows[0]?.n ?? "0", 10) || 0
  const oldestCreated = found.rows[0]?.oldest ? new Date(found.rows[0].oldest).toISOString() : null
  if (!input?.execute) return { matched, updated: 0, oldestCreated }
  const res = await query(
    `WITH picked AS (
       SELECT id, row_number() OVER (ORDER BY id) AS rn
       FROM amazon_price_verification_tasks
       WHERE claimed_by_source = 'SERVER_BROWSER_AUTH'
         AND status IN ('PENDING','RETRYABLE','WAITING_FOR_WORKER')
         AND reason = 'PRICE_MISSING'
       ORDER BY id
       LIMIT $1::int
     )
     UPDATE amazon_price_verification_tasks t
     SET claimed_by_source = NULL,
         worker_id = NULL,
         lease_expires_at = NULL,
         status = 'PENDING',
         reason = 'SOURCE_STALE',
         failure_code = 'AUTH_RECHECK_PUBLIC',
         failure_message = 'Reassigned from auth PRICE_MISSING to public unauthenticated recheck',
         available_at = NOW() + make_interval(mins => ((picked.rn % $2::int))),
         updated_at = NOW()
     FROM picked
     WHERE t.id = picked.id`,
    [limit, spread]
  )
  return { matched, updated: res.rowCount ?? 0, oldestCreated }
}
