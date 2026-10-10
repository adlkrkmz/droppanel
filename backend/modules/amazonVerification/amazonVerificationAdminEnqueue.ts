import { query } from "../../db/client"
import { loadAmazonVerificationConfig } from "./amazonVerificationConfig"
import { enqueueVerificationTask } from "./amazonVerificationQueue"
import { userIsActiveMemberOfWorkspace } from "../auth/authRepository"

export async function enqueueAdminTestTasks(input: {
  asins: string[]
  workspaceId: string
  preferredUserId: string
}): Promise<{ ok: true; created: number; reused: number; tasks: Array<{ taskId: number; asin: string; created: boolean }> }> {
  const cfg = loadAmazonVerificationConfig()
  const unique = [...new Set(input.asins.map(a => a.trim().toUpperCase()).filter(a => /^[A-Z0-9]{10}$/.test(a)))]
  if (unique.length === 0) throw Object.assign(new Error("asins required"), { status: 400 })
  if (unique.length > cfg.testEnqueueMaxAsins) {
    throw Object.assign(new Error(`Max ${cfg.testEnqueueMaxAsins} ASINs per test enqueue`), { status: 400 })
  }
  const member = await userIsActiveMemberOfWorkspace(input.preferredUserId, input.workspaceId)
  if (!member) throw Object.assign(new Error("preferredUserId is not an active member of workspace"), { status: 403 })

  const tasks: Array<{ taskId: number; asin: string; created: boolean }> = []
  let created = 0
  let reused = 0
  for (const asin of unique) {
    const resolved = await query<{
      global_asin_id: string
      catalog_state_id: string
    }>(
      `SELECT g.id::text AS global_asin_id, c.catalog_state_id::text AS catalog_state_id
       FROM global_amazon_asins g
       JOIN global_asin_consumers c ON c.global_asin_id = g.id
       JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
       WHERE g.asin = $1
         AND c.workspace_id = $2::uuid
         AND scs.workspace_id = $2::uuid
       ORDER BY c.id ASC
       LIMIT 1`,
      [asin, input.workspaceId]
    )
    const row = resolved.rows[0]
    if (!row) {
      throw Object.assign(new Error(`ASIN ${asin} has no catalog consumer in workspace`), { status: 404 })
    }
    const result = await enqueueVerificationTask({
      globalAsinId: Number(row.global_asin_id),
      workspaceId: input.workspaceId,
      preferredUserId: input.preferredUserId,
      catalogStateId: Number(row.catalog_state_id),
      asin,
      reason: "ADMIN_TEST",
      priority: 0,
    })
    if (result.created) created++
    else reused++
    tasks.push({ taskId: result.taskId, asin, created: result.created })
  }
  return { ok: true, created, reused, tasks }
}
