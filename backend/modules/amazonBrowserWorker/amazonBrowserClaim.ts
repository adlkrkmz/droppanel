import { db, query } from "../../db/client"
import { loadAmazonVerificationConfig } from "../amazonVerification/amazonVerificationConfig"
import { AMAZON_VERIFICATION_SERVER_CLAIM_SQL } from "../amazonVerification/amazonVerificationServerClaimSql"
import type { ClaimNextVerificationResult, VerificationTaskRow } from "../amazonVerification/amazonVerificationQueue"
import type { VerificationReason, VerificationTaskStatus } from "../amazonVerification/amazonVerificationTypes"

export async function claimNextServerBrowserVerificationTask(input: {
  workerId: string
}): Promise<ClaimNextVerificationResult> {
  const cfg = loadAmazonVerificationConfig()
  if (!cfg.serverBrowserEnabled) return { ok: true, task: null, message: "NO_WORK" }
  const allowAllReasons = cfg.verificationEnabled === true || cfg.serverBrowserEnabled === true
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    // Count any in-flight ownership, including lease-expired RUNNING.
    // Expired RUNNING is recovered by the independent watchdog (not by claiming
    // a second task while the first attempt is still wedged in-process).
    const busy = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM amazon_price_verification_tasks
       WHERE worker_id = $1
         AND status IN ('CLAIMED','RUNNING')`,
      [input.workerId]
    )
    if ((parseInt(busy.rows[0]?.c ?? "0", 10) || 0) >= cfg.maxConcurrentTasksPerWorker) {
      await client.query("COMMIT")
      return { ok: true, task: null, message: "NO_WORK" }
    }
    const claimed = await client.query<{
      id: number
      global_asin_id: string
      workspace_id: string
      preferred_user_id: string
      catalog_state_id: string
      asin: string
      amazon_url: string
      reason: VerificationReason
      status: VerificationTaskStatus
      attempt_count: number
      lease_expires_at: Date | null
    }>(AMAZON_VERIFICATION_SERVER_CLAIM_SQL, [input.workerId, cfg.leaseSeconds, allowAllReasons])
    const row = claimed.rows[0]
    if (!row) {
      await client.query("COMMIT")
      return { ok: true, task: null, message: "NO_WORK" }
    }
    await client.query("COMMIT")
    const task: VerificationTaskRow = {
      id: Number(row.id),
      globalAsinId: Number(row.global_asin_id),
      workspaceId: row.workspace_id,
      preferredUserId: row.preferred_user_id,
      catalogStateId: Number(row.catalog_state_id),
      asin: row.asin,
      amazonUrl: row.amazon_url,
      reason: row.reason,
      status: "CLAIMED",
      attemptCount: Number(row.attempt_count) || 0,
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
    }
    return { ok: true, task }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

export async function releaseServerBrowserVerificationTask(input: {
  taskId: number
  workerId: string
}): Promise<void> {
  await query(
    `UPDATE amazon_price_verification_tasks
     SET status = 'WAITING_FOR_WORKER',
         worker_id = NULL,
         claimed_by_source = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $1::bigint
       AND worker_id = $2
       AND status IN ('CLAIMED','RUNNING')`,
    [input.taskId, input.workerId]
  )
}
