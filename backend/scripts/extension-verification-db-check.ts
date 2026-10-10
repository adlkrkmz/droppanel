import "dotenv/config"
import { closeDbPool, query } from "../db/client"
import { enqueueVerificationTask, claimNextVerificationTask } from "../modules/amazonVerification/amazonVerificationQueue"
import { upsertExtensionHeartbeat } from "../modules/amazonVerification/extensionWorkerRegistry"

async function main(): Promise<void> {
  const host = new URL(process.env.DATABASE_URL ?? "postgres://localhost").hostname.toLowerCase()
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("local DB only")

  const joined = await query<{
    workspace_id: string
    user_id: string
    global_asin_id: string
    catalog_state_id: string
    asin: string
  }>(
    `SELECT wm.workspace_id::text AS workspace_id,
            wm.user_id::text AS user_id,
            g.id::text AS global_asin_id,
            c.catalog_state_id::text AS catalog_state_id,
            g.asin
     FROM workspace_members wm
     JOIN global_asin_consumers c ON c.workspace_id = wm.workspace_id
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     LIMIT 1`
  )
  const row = joined.rows[0]
  if (!row) {
    console.log("DB_CHECK_SKIP no member+consumer")
    return
  }
  const asinRow = row
  const first = await enqueueVerificationTask({
    globalAsinId: Number(asinRow.global_asin_id),
    workspaceId: row.workspace_id,
    preferredUserId: row.user_id,
    catalogStateId: Number(asinRow.catalog_state_id),
    asin: asinRow.asin,
    reason: "ADMIN_TEST",
    priority: 0,
  })
  const second = await enqueueVerificationTask({
    globalAsinId: Number(asinRow.global_asin_id),
    workspaceId: row.workspace_id,
    preferredUserId: row.user_id,
    catalogStateId: Number(asinRow.catalog_state_id),
    asin: asinRow.asin,
    reason: "ADMIN_TEST",
    priority: 0,
  })
  if (second.created || second.taskId !== first.taskId) throw new Error("duplicate enqueue created a second active task")
  const hb = await upsertExtensionHeartbeat({
    userId: row.user_id,
    workspaceId: row.workspace_id,
    deviceId: "faz3a-db-check",
    amazonAvailable: true,
  })
  const claimed = await claimNextVerificationTask({
    workspaceId: row.workspace_id,
    userId: row.user_id,
    workerId: hb.workerId,
  })
  if (!claimed.task || claimed.task.id !== first.taskId) throw new Error("preferred user failed to claim")
  const other = await query<{ user_id: string }>(
    `SELECT user_id::text AS user_id FROM workspace_members
     WHERE workspace_id = $1::uuid AND user_id <> $2::uuid LIMIT 1`,
    [row.workspace_id, row.user_id]
  )
  if (other.rows[0]) {
    const otherHb = await upsertExtensionHeartbeat({
      userId: other.rows[0].user_id,
      workspaceId: row.workspace_id,
      deviceId: "faz3a-other",
    })
    const blocked = await claimNextVerificationTask({
      workspaceId: row.workspace_id,
      userId: other.rows[0].user_id,
      workerId: otherHb.workerId,
    })
    if (blocked.task) throw new Error("other user claimed preferred-user task")
  }
  await query(
    `UPDATE amazon_price_verification_tasks
     SET status = 'CANCELLED', worker_id = NULL, lease_expires_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [first.taskId]
  )
  console.log("DB_CHECK_PASS", { taskId: first.taskId, duplicateBlocked: true, preferredClaim: true })
}

void main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => {
    void closeDbPool()
  })
