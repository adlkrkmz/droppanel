// ----------------------------------------------------------------
// scheduledPublishRunnerService.ts — simulation runner (no eBay write)
// ----------------------------------------------------------------

import type { PoolClient } from "pg"
import { db } from "../../db/client"
import {
  splitEligiblePoolItems,
} from "../pool/poolEligibilityService"
import { finalizeCommandProgress } from "./scheduledPublishService"
import type {
  ScheduledRunnerResult,
  ScheduledRunnerRunDueResponse,
} from "./scheduledPublishTypes"

type DueJobRow = {
  job_id:         number
  command_id:     number
  pool_id:        number
  asin:           string | null
  scheduled_at:   string
  store_code:     string
  title_mode:     string
  command_status: string
}

async function claimDueJobs(
  client:      PoolClient,
  workspaceId: string,
  limit:       number,
  storeCode:   string | null
): Promise<DueJobRow[]> {
  const result = await client.query<DueJobRow>(
    `SELECT
       spj.id AS job_id,
       spj.command_id,
       spj.pool_id,
       spj.asin,
       spj.scheduled_at::text AS scheduled_at,
       spc.store_code,
       spc.title_mode,
       spc.status AS command_status
     FROM scheduled_publish_jobs spj
     INNER JOIN scheduled_publish_commands spc ON spc.id = spj.command_id
     WHERE spj.workspace_id = $1
       AND spj.status = 'scheduled'
       AND spj.scheduled_at <= NOW()
       AND spc.status IN ('scheduled', 'running')
       AND COALESCE(spc.metadata->>'executionMode', 'simulation') = 'simulation'
       AND ($2::text IS NULL OR spc.store_code = $2)
     ORDER BY spj.scheduled_at ASC, spj.id ASC
     LIMIT $3
     FOR UPDATE OF spj SKIP LOCKED`,
    [workspaceId, storeCode, limit]
  )
  return result.rows
}

async function markJobRunning(client: PoolClient, jobId: number): Promise<void> {
  await client.query(
    `UPDATE scheduled_publish_jobs
     SET status = 'running',
         attempt_count = attempt_count + 1,
         updated_at = NOW()
     WHERE id = $1`,
    [jobId]
  )
}

async function markCommandRunning(client: PoolClient, commandId: number): Promise<void> {
  await client.query(
    `UPDATE scheduled_publish_commands
     SET status = 'running',
         updated_at = NOW()
     WHERE id = $1
       AND status = 'scheduled'`,
    [commandId]
  )
}

async function processDueJob(
  client:      PoolClient,
  workspaceId: string,
  row:         DueJobRow
): Promise<ScheduledRunnerResult> {
  const base = {
    jobId:     row.job_id,
    commandId: row.command_id,
    poolId:    row.pool_id,
    asin:      row.asin,
  }

  await markJobRunning(client, row.job_id)
  await markCommandRunning(client, row.command_id)

  const split = await splitEligiblePoolItems(workspaceId, [row.pool_id])
  if (split.eligibleIds.length === 0) {
    const reason = split.skipDetails[0]?.reason ?? "POOL_ITEM_NOT_ELIGIBLE"
    await client.query(
      `UPDATE scheduled_publish_jobs
       SET status = 'skipped',
           error_message = $2,
           result = $3::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [
        row.job_id,
        reason,
        JSON.stringify({ skipped: true, reason, simulation: true }),
      ]
    )
    return { ...base, ok: true, status: "skipped", message: reason }
  }

  const simulatedAt = new Date().toISOString()
  const resultPayload = {
    simulation:    true,
    wouldPublish:  true,
    titleMode:     row.title_mode,
    executionMode: "simulation",
    poolId:        row.pool_id,
    asin:          row.asin,
    storeCode:     row.store_code,
    scheduledAt:   row.scheduled_at,
    simulatedAt,
  }

  try {
    await client.query(
      `UPDATE scheduled_publish_jobs
       SET status = 'simulated',
           result = $2::jsonb,
           error_message = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [row.job_id, JSON.stringify(resultPayload)]
    )
    return { ...base, ok: true, status: "simulated", message: "Simulation completed." }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await client.query(
      `UPDATE scheduled_publish_jobs
       SET status = 'failed',
           error_message = $2,
           failed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [row.job_id, msg.slice(0, 500)]
    )
    return { ...base, ok: false, status: "failed", message: msg }
  }
}

export async function runDueSimulation(
  workspaceId: string,
  opts: { limit?: number; storeCode?: string | null }
): Promise<ScheduledRunnerRunDueResponse> {
  const requestedLimit = Math.min(20, Math.max(1, opts.limit ?? 5))
  const storeCode = opts.storeCode?.trim() || null

  const client = await db.connect()
  const results: ScheduledRunnerResult[] = []
  const touchedCommands = new Set<number>()

  try {
    await client.query("BEGIN")

    const dueJobs = await claimDueJobs(client, workspaceId, requestedLimit, storeCode)

    for (const row of dueJobs) {
      const result = await processDueJob(client, workspaceId, row)
      results.push(result)
      touchedCommands.add(row.command_id)
    }

    for (const commandId of touchedCommands) {
      await finalizeCommandProgress(client, workspaceId, commandId)
    }

    await client.query("COMMIT")
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }

  const simulated = results.filter(r => r.status === "simulated").length
  const failed    = results.filter(r => r.status === "failed").length
  const skipped   = results.filter(r => r.status === "skipped").length

  return {
    ok:             true,
    mode:           "simulation",
    requestedLimit,
    processed:      results.length,
    simulated,
    failed,
    skipped,
    results,
  }
}
