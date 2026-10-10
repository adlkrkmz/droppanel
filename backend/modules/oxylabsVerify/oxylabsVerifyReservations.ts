import type { PoolClient } from "pg"
import { query } from "../../db/client"
import { resolveOxylabsVerifyClaimKind } from "./oxylabsVerifyKinds"

type Q = { query: PoolClient["query"] }

function asQ(client?: Q): Q {
  return client ?? { query: ((sql: string, params?: unknown[]) => query(sql, params as never)) as PoolClient["query"] }
}

export async function countOxylabsCallReservations(client?: Q): Promise<number> {
  const res = await asQ(client).query(`SELECT COUNT(*)::text AS c FROM oxylabs_verify_call_reservations`)
  return parseInt(String((res as { rows: Array<{ c: string }> }).rows[0]?.c ?? "0"), 10) || 0
}

export async function jobHasOxylabsCallReservation(jobId: number, client?: Q): Promise<boolean> {
  const res = await asQ(client).query(
    `SELECT 1 FROM oxylabs_verify_call_reservations WHERE job_id = $1::bigint LIMIT 1`,
    [jobId]
  )
  return Boolean((res as { rows: unknown[] }).rows[0])
}

/**
 * Serialize via canary_state row lock. Insert reservation for job_id at most once.
 * Returns reserved:false when cap is full and this job has no prior reservation.
 */
export async function reserveOxylabsProviderCall(input: {
  client: PoolClient
  jobId: number
  workerId: string
  cap: number
  cycleStart?: Date | null
  cycleEnd?: Date | null
}): Promise<{ reserved: boolean; count: number; existing: boolean }> {
  const role = resolveOxylabsVerifyClaimKind(input.workerId) === "OXYLABS_PRODUCT_CONFIRM" ? "CONFIRM" : "PRIMARY"
  await input.client.query(`SELECT id FROM oxylabs_verify_canary_state WHERE id = 1 FOR UPDATE`)
  const existing = await input.client.query(
    `SELECT job_id FROM oxylabs_verify_call_reservations WHERE job_id = $1::bigint LIMIT 1`,
    [input.jobId]
  )
  if (existing.rows[0]) {
    const count = await countOxylabsCallReservations(input.client)
    return { reserved: true, count, existing: true }
  }
  const countRes =
    input.cycleStart && input.cycleEnd
      ? await input.client.query<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM oxylabs_verify_call_reservations
           WHERE reserved_at >= $1::timestamptz AND reserved_at < $2::timestamptz`,
          [input.cycleStart.toISOString(), input.cycleEnd.toISOString()]
        )
      : await input.client.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM oxylabs_verify_call_reservations`)
  const count = parseInt(countRes.rows[0]?.c ?? "0", 10) || 0
  if (count >= input.cap) {
    return { reserved: false, count, existing: false }
  }
  await input.client.query(
    `INSERT INTO oxylabs_verify_call_reservations (job_id, worker_id, worker_role)
     VALUES ($1::bigint, $2, $3)
     ON CONFLICT (job_id) DO NOTHING`,
    [input.jobId, input.workerId, role]
  )
  const after = await countOxylabsCallReservations(input.client)
  return { reserved: true, count: after, existing: false }
}
