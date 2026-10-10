import "dotenv/config"
import { closeDbPool, query } from "../db/client"

async function main(): Promise<void> {
  const before = await query<{ tokens_left: number | null; refill_rate: number | null }>(
    `SELECT tokens_left, refill_rate FROM keepa_platform_token_state WHERE id = 1`
  )
  console.log("TOKEN_BEFORE", before.rows[0] ?? null)
  await query(
    `UPDATE keepa_platform_token_state
     SET refill_rate = 20,
         tokens_left = NULL,
         last_tokens_consumed = NULL,
         updated_at = NOW()
     WHERE id = 1
       AND COALESCE(refill_rate, 0) = 0`
  )
  const after = await query<{ tokens_left: number | null; refill_rate: number | null }>(
    `SELECT tokens_left, refill_rate FROM keepa_platform_token_state WHERE id = 1`
  )
  console.log("TOKEN_AFTER", after.rows[0] ?? null)
  const usage = await query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM keepa_platform_usage GROUP BY status ORDER BY n DESC`
  )
  console.log("USAGE", usage.rows)
  const snaps = await query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM global_keepa_snapshots GROUP BY status ORDER BY n DESC`
  )
  console.log("SNAPSHOTS", snaps.rows)
  const planner = await query<{ n: string; due: string; claimed: string }>(
    `SELECT COUNT(*)::text AS n,
            SUM(CASE WHEN next_check_at IS NULL OR next_check_at <= NOW() THEN 1 ELSE 0 END)::text AS due,
            SUM(CASE WHEN claimed_until IS NOT NULL AND claimed_until > NOW() THEN 1 ELSE 0 END)::text AS claimed
     FROM global_keepa_planner_state`
  )
  console.log("PLANNER_STATE", planner.rows[0] ?? null)
}

void main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => {
    void closeDbPool()
  })
