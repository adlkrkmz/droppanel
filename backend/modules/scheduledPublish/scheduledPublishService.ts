// ----------------------------------------------------------------
// scheduledPublishService.ts — schedule command/job planning (no publish runner)
// ----------------------------------------------------------------

import { db, query } from "../../db/client"
import {
  buildPoolEligibilityWhere,
  normalizePoolId,
  splitEligiblePoolItems,
} from "../pool/poolEligibilityService"
import type {
  ScheduleCommandActionResponse,
  ScheduleCommandDetailResponse,
  ScheduleCommandListResponse,
  ScheduleExecutionMode,
  ScheduleJobListResponse,
  ScheduleJobProgress,
  SchedulePublishRequest,
  SchedulePublishResponse,
  ScheduleSelectionMode,
  ScheduleSkipDetail,
  ScheduledPublishCommand,
  ScheduledPublishJob,
} from "./scheduledPublishTypes"

const READY_STAGES = new Set(["validated", "scraped", "ai_generated"])
const ACTIVE_JOB_STATUSES = ["scheduled", "running"] as const
const ACTIVE_COMMAND_STATUSES = ["scheduled", "running", "paused"] as const
const TERMINAL_JOB_STATUSES = ["published", "failed", "skipped", "cancelled", "simulated"] as const

type PoolCandidate = {
  poolId:          number
  asin:            string | null
  assignedStoreId: number | null
  status:          string
  pipelineStage:   string
}

type StoreRow = { id: number; storeCode: string; name: string; status: string }

export function getExecutionMode(metadata: Record<string, unknown> | null | undefined): ScheduleExecutionMode {
  const raw = metadata?.executionMode
  return raw === "live" ? "live" : "simulation"
}

// ─── Store lookup ─────────────────────────────────────────────

async function findActiveStore(
  workspaceId: string,
  storeCode:   string
): Promise<StoreRow | null> {
  const result = await query<{
    id: number; store_code: string; name: string; status: string
  }>(
    `SELECT id, store_code, name, status
     FROM stores
     WHERE workspace_id = $1 AND store_code = $2
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  const row = result.rows[0]
  if (!row) return null
  return { id: row.id, storeCode: row.store_code, name: row.name, status: row.status }
}

// ─── Duplicate queue guard ────────────────────────────────────

async function fetchAlreadyQueuedPoolIds(
  workspaceId: string,
  poolIds:     number[]
): Promise<Set<number>> {
  if (poolIds.length === 0) return new Set()

  const result = await query<{ pool_id: number }>(
    `SELECT DISTINCT spj.pool_id
     FROM scheduled_publish_jobs spj
     INNER JOIN scheduled_publish_commands spc ON spc.id = spj.command_id
     WHERE spj.workspace_id = $1
       AND spj.pool_id = ANY($2::bigint[])
       AND spj.status = ANY($3::text[])
       AND spc.status = ANY($4::text[])`,
    [workspaceId, poolIds, [...ACTIVE_JOB_STATUSES], [...ACTIVE_COMMAND_STATUSES]]
  )
  return new Set(
    result.rows
      .map(r => normalizePoolId(r.pool_id))
      .filter((id): id is number => id != null)
  )
}

// ─── ready_next candidates ────────────────────────────────────

async function fetchReadyNextCandidates(
  workspaceId: string,
  limit:       number
): Promise<PoolCandidate[]> {
  const eligibilityWhere = buildPoolEligibilityWhere("ap")
  const result = await query<{
    pool_id:           number
    asin:              string | null
    assigned_store_id: number | null
    status:            string
    pipeline_stage:    string
  }>(
    `SELECT
       ap.id AS pool_id,
       ar.asin,
       ap.assigned_store_id,
       ap.status::text AS status,
       ap.pipeline_stage::text AS pipeline_stage
     FROM asin_pool ap
     LEFT JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id = $1
       AND ${eligibilityWhere}
       AND ap.status = 'ready'
       AND ap.pipeline_stage IN ('validated', 'scraped', 'ai_generated')
     ORDER BY ap.id ASC
     LIMIT $2`,
    [workspaceId, limit]
  )
  return result.rows
    .map(r => {
      const poolId = normalizePoolId(r.pool_id)
      if (poolId == null) return null
      return {
        poolId,
        asin:            r.asin,
        assignedStoreId: r.assigned_store_id,
        status:          r.status,
        pipelineStage:   r.pipeline_stage,
      }
    })
    .filter((c): c is PoolCandidate => c != null)
}

function isReadyStage(candidate: PoolCandidate): boolean {
  return candidate.status === "ready" && READY_STAGES.has(candidate.pipelineStage)
}

async function resolveScheduleCandidates(
  workspaceId:   string,
  storeId:       number,
  selectionMode: ScheduleSelectionMode,
  poolIds:       number[] | undefined,
  count:         number
): Promise<{ eligible: PoolCandidate[]; skipDetails: ScheduleSkipDetail[]; requestedCount: number }> {
  const skipDetails: ScheduleSkipDetail[] = []
  let candidates: PoolCandidate[] = []
  let requestedCount = count

  if (selectionMode === "selected") {
    const ids = [...new Set(poolIds ?? [])]
    requestedCount = ids.length
    const split = await splitEligiblePoolItems(workspaceId, ids)
    skipDetails.push(...split.skipDetails)
    candidates = await enrichCandidates(workspaceId, split.eligibleIds)
    const order = new Map(ids.map((id, i) => [id, i]))
    candidates.sort((a, b) => (order.get(a.poolId) ?? 0) - (order.get(b.poolId) ?? 0))
  } else {
    requestedCount = count
    candidates = await fetchReadyNextCandidates(workspaceId, count * 3)
  }

  const queuedSet = await fetchAlreadyQueuedPoolIds(
    workspaceId,
    candidates.map(c => c.poolId)
  )

  const eligible: PoolCandidate[] = []

  for (const c of candidates) {
    if (eligible.length >= count && selectionMode === "ready_next") break

    if (!isReadyStage(c)) {
      skipDetails.push({ poolId: c.poolId, asin: c.asin, reason: "NOT_READY" })
      continue
    }

    if (c.assignedStoreId != null && c.assignedStoreId !== storeId) {
      skipDetails.push({ poolId: c.poolId, asin: c.asin, reason: "STORE_CONFLICT" })
      continue
    }

    if (queuedSet.has(c.poolId)) {
      skipDetails.push({ poolId: c.poolId, asin: c.asin, reason: "POOL_ITEM_ALREADY_QUEUED" })
      continue
    }

    eligible.push(c)
    if (selectionMode === "ready_next" && eligible.length >= count) break
  }

  return { eligible, skipDetails, requestedCount }
}

async function enrichCandidates(
  workspaceId: string,
  poolIds:     number[]
): Promise<PoolCandidate[]> {
  if (poolIds.length === 0) return []
  const result = await query<{
    pool_id: number; asin: string | null; assigned_store_id: number | null
    status: string; pipeline_stage: string
  }>(
    `SELECT ap.id AS pool_id, ar.asin, ap.assigned_store_id,
            ap.status::text AS status, ap.pipeline_stage::text AS pipeline_stage
     FROM asin_pool ap
     LEFT JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id = $1 AND ap.id = ANY($2::bigint[])`,
    [workspaceId, poolIds.map(id => normalizePoolId(id)).filter((id): id is number => id != null)]
  )
  const map = new Map(
    result.rows
      .map(r => {
        const id = normalizePoolId(r.pool_id)
        return id != null ? [id, r] as const : null
      })
      .filter((e): e is readonly [number, typeof result.rows[0]] => e != null)
  )
  return poolIds
    .map(id => normalizePoolId(id))
    .filter((id): id is number => id != null && map.has(id))
    .map(id => {
      const r = map.get(id)!
      return {
        poolId:          id,
        asin:            r.asin,
        assignedStoreId: r.assigned_store_id,
        status:          r.status,
        pipelineStage:   r.pipeline_stage,
      }
    })
}

// ─── Progress counts ──────────────────────────────────────────

async function fetchJobProgress(commandId: number): Promise<ScheduleJobProgress> {
  const result = await query<{ status: string; cnt: string }>(
    `SELECT status, COUNT(*)::text AS cnt
     FROM scheduled_publish_jobs
     WHERE command_id = $1
     GROUP BY status`,
    [commandId]
  )
  const progress: ScheduleJobProgress = {
    scheduled: 0, running: 0, simulated: 0, published: 0, failed: 0, cancelled: 0, skipped: 0, total: 0,
  }
  for (const row of result.rows) {
    const n = parseInt(row.cnt, 10)
    progress.total += n
    if (row.status in progress) {
      (progress as Record<string, number>)[row.status] = n
    }
  }
  return progress
}

async function countPendingExtensionCapturesForPublishCommand(
  runQuery: (text: string, params?: unknown[]) => Promise<{ rows: Array<{ cnt: string }> }>,
  publishCommandId: number
): Promise<number> {
  const result = await runQuery(
    `SELECT COUNT(*)::text AS cnt
     FROM extension_capture_items eci
     INNER JOIN extension_capture_commands ecc ON ecc.id = eci.command_id
     WHERE ecc.publish_command_id = $1
       AND eci.status IN ('capture_pending', 'capturing')`,
    [publishCommandId]
  )
  return parseInt(result.rows[0]?.cnt ?? "0", 10)
}

export async function finalizeCommandProgress(
  clientOrWorkspace: import("pg").PoolClient | string,
  workspaceOrCommandId: string | number,
  commandIdParam?: number
): Promise<void> {
  const useClient = typeof clientOrWorkspace !== "string"
  const client = useClient ? clientOrWorkspace as import("pg").PoolClient : null
  const workspaceId = useClient ? workspaceOrCommandId as string : clientOrWorkspace
  const commandId = useClient ? commandIdParam! : workspaceOrCommandId as number

  const runQuery = client
    ? client.query.bind(client)
    : query

  const progressResult = await runQuery<{ status: string; cnt: string }>(
    `SELECT status, COUNT(*)::text AS cnt
     FROM scheduled_publish_jobs
     WHERE command_id = $1
     GROUP BY status`,
    [commandId]
  )

  const terminalSet = new Set<string>(TERMINAL_JOB_STATUSES)
  let totalJobs = 0
  let nonTerminalJobs = 0
  let failed = 0
  for (const row of progressResult.rows) {
    const n = parseInt(row.cnt, 10)
    totalJobs += n
    if (row.status === "failed") failed = n
    if (terminalSet.has(row.status)) continue
    nonTerminalJobs += n
  }

  const pendingCaptures = await countPendingExtensionCapturesForPublishCommand(runQuery, commandId)
  const hasPendingWork = nonTerminalJobs > 0 || pendingCaptures > 0

  if (hasPendingWork) {
    await runQuery(
      `UPDATE scheduled_publish_commands
       SET status = 'running',
           completed_at = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2
         AND status NOT IN ('cancelled', 'paused')`,
      [workspaceId, commandId]
    )
    return
  }

  if (totalJobs === 0) return

  const newStatus = failed > 0 ? "failed" : "completed"
  await runQuery(
    `UPDATE scheduled_publish_commands
     SET status = $3,
         completed_at = NOW(),
         updated_at = NOW(),
         last_error = CASE WHEN $3 = 'failed' THEN 'One or more jobs failed' ELSE NULL END
     WHERE workspace_id = $1 AND id = $2
       AND status NOT IN ('cancelled', 'paused')`,
    [workspaceId, commandId, newStatus]
  )
}

/** Re-open commands wrongly marked completed while jobs or captures remain. */
export async function reopenCompletedCommandsWithPendingWork(): Promise<number> {
  const result = await query<{ id: number }>(
    `UPDATE scheduled_publish_commands spc
     SET status = 'running',
         completed_at = NULL,
         updated_at = NOW()
     WHERE spc.status = 'completed'
       AND (
         EXISTS (
           SELECT 1 FROM scheduled_publish_jobs spj
           WHERE spj.command_id = spc.id
             AND spj.status IN ('scheduled', 'running')
         )
         OR EXISTS (
           SELECT 1 FROM extension_capture_items eci
           INNER JOIN extension_capture_commands ecc ON ecc.id = eci.command_id
           WHERE ecc.publish_command_id = spc.id
             AND eci.status IN ('capture_pending', 'capturing')
         )
       )
     RETURNING spc.id`
  )
  if (result.rows.length > 0) {
    console.log("[BulkJobRunner] reopened_completed_commands", { count: result.rows.length })
  }
  return result.rows.length
}

type CommandRow = {
  id: number; store_code: string; title: string | null; status: string
  selection_mode: string; requested_count: number; eligible_count: number
  skipped_count: number; created_job_count: number; start_at: string
  interval_seconds: number; quantity: number; title_mode: string
  created_at: string; updated_at: string; paused_at: string | null
  cancelled_at: string | null; completed_at: string | null; last_error: string | null
  metadata: Record<string, unknown>
}

function mapCommand(row: CommandRow, progress?: ScheduleJobProgress): ScheduledPublishCommand {
  const metadata = row.metadata ?? {}
  return {
    id:              row.id,
    storeCode:       row.store_code,
    title:           row.title,
    status:          row.status as ScheduledPublishCommand["status"],
    selectionMode:   row.selection_mode,
    requestedCount:  row.requested_count,
    eligibleCount:   row.eligible_count,
    skippedCount:    row.skipped_count,
    createdJobCount: row.created_job_count,
    startAt:         row.start_at,
    intervalSeconds: row.interval_seconds,
    quantity:        row.quantity,
    titleMode:       row.title_mode,
    executionMode:   getExecutionMode(metadata),
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
    pausedAt:        row.paused_at,
    cancelledAt:     row.cancelled_at,
    completedAt:     row.completed_at,
    lastError:       row.last_error,
    metadata,
    progress,
  }
}

type JobRow = {
  id: number; command_id: number; pool_id: number; asin: string | null
  scheduled_at: string; status: string; attempt_count: number
  error_message: string | null; published_at: string | null
  failed_at: string | null; cancelled_at: string | null
}

function mapJob(row: JobRow): ScheduledPublishJob {
  return {
    id:           row.id,
    commandId:    row.command_id,
    poolId:       row.pool_id,
    asin:         row.asin,
    scheduledAt:  row.scheduled_at,
    status:       row.status as ScheduledPublishJob["status"],
    attemptCount: row.attempt_count,
    errorMessage: row.error_message,
    publishedAt:  row.published_at,
    failedAt:     row.failed_at,
    cancelledAt:  row.cancelled_at,
  }
}

async function loadCommandRow(
  workspaceId: string,
  commandId:   number
): Promise<CommandRow | null> {
  const result = await query<CommandRow>(
    `SELECT id, store_code, title, status, selection_mode,
            requested_count, eligible_count, skipped_count, created_job_count,
            start_at::text, interval_seconds, quantity, title_mode,
            created_at::text, updated_at::text,
            paused_at::text, cancelled_at::text, completed_at::text,
            last_error, metadata
     FROM scheduled_publish_commands
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, commandId]
  )
  return result.rows[0] ?? null
}

// ─── Create schedule (transaction) ────────────────────────────

export async function createScheduledPublish(
  workspaceId: string,
  req:         SchedulePublishRequest
): Promise<SchedulePublishResponse> {
  const store = await findActiveStore(workspaceId, req.storeCode.trim())
  if (!store) throw new Error("Store not found")
  if (store.status !== "active") throw new Error(`Store is not active: ${store.name}`)

  const { eligible, skipDetails, requestedCount } = await resolveScheduleCandidates(
    workspaceId,
    store.id,
    req.selectionMode,
    req.poolIds,
    req.count
  )

  if (eligible.length === 0) {
    const err = new Error("No eligible pool items to schedule.") as Error & { skipDetails?: ScheduleSkipDetail[] }
    err.skipDetails = skipDetails
    throw err
  }

  const startAt = new Date(req.startAt)
  const executionMode = req.executionMode ?? "simulation"
  const metadata = {
    selectionMode:    req.selectionMode,
    requestedPoolIds: req.poolIds ?? [],
    skipDetails,
    titleMode:        req.titleMode ?? "titlebot",
    executionMode,
    source:           "admin_pool_schedule",
  }

  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const cmdResult = await client.query<CommandRow>(
      `INSERT INTO scheduled_publish_commands (
         workspace_id, store_id, store_code, title, selection_mode,
         requested_count, eligible_count, skipped_count, created_job_count,
         start_at, interval_seconds, quantity, title_mode, status,
         created_by, metadata
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12, $13, 'scheduled',
         'admin', $14::jsonb
       )
       RETURNING id, store_code, title, status, selection_mode,
                 requested_count, eligible_count, skipped_count, created_job_count,
                 start_at::text, interval_seconds, quantity, title_mode,
                 created_at::text, updated_at::text,
                 paused_at::text, cancelled_at::text, completed_at::text,
                 last_error, metadata`,
      [
        workspaceId, store.id, store.storeCode, req.title ?? null, req.selectionMode,
        requestedCount, eligible.length, skipDetails.length, eligible.length,
        startAt.toISOString(), req.intervalSeconds, req.quantity ?? 1, req.titleMode ?? "titlebot",
        JSON.stringify(metadata),
      ]
    )
    const command = cmdResult.rows[0]
    if (!command) throw new Error("Failed to create schedule command")

    const poolIdsArr: number[] = []
    const asinsArr: (string | null)[] = []
    const scheduledAts: string[] = []

    eligible.forEach((item, index) => {
      poolIdsArr.push(item.poolId)
      asinsArr.push(item.asin)
      const at = new Date(startAt.getTime() + index * req.intervalSeconds * 1000)
      scheduledAts.push(at.toISOString())
    })

    await client.query(
      `INSERT INTO scheduled_publish_jobs (
         workspace_id, command_id, store_id, store_code,
         pool_id, asin, scheduled_at, status
       )
       SELECT $1, $2, $3, $4, u.pool_id, u.asin, u.scheduled_at::timestamptz, 'scheduled'
       FROM UNNEST($5::bigint[], $6::text[], $7::text[]) AS u(pool_id, asin, scheduled_at)`,
      [workspaceId, command.id, store.id, store.storeCode, poolIdsArr, asinsArr, scheduledAts]
    )

    await client.query("COMMIT")

    const progress = await fetchJobProgress(command.id)
    console.log("[BulkJob] created", {
      commandId:     command.id,
      storeCode:   store.storeCode,
      countRequested: requestedCount,
      itemsCreated:   eligible.length,
      titleMode:   req.titleMode ?? "titlebot",
      delaySec:    req.intervalSeconds,
    })
    for (let i = 0; i < eligible.length; i++) {
      console.log("[BulkJob] item created", {
        commandId: command.id,
        poolId:    eligible[i].poolId,
        asin:      eligible[i].asin,
        scheduledAt: scheduledAts[i],
      })
    }

    return {
      ok: true,
      command: mapCommand(command, progress),
      skipDetails: skipDetails.length > 0 ? skipDetails : undefined,
    }
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

// ─── List commands ────────────────────────────────────────────

/** Reset jobs stuck in running after backend crash (duplicate guard runs before publish). */
export async function recoverStuckLiveJobs(staleMinutes = 15): Promise<number> {
  const result = await query<{ id: number }>(
    `UPDATE scheduled_publish_jobs
     SET status = 'scheduled',
         updated_at = NOW()
     WHERE status = 'running'
       AND updated_at < NOW() - ($1::text || ' minutes')::interval
     RETURNING id`,
    [String(Math.max(5, staleMinutes))]
  )
  if (result.rows.length > 0) {
    console.log("[BulkJobRunner] recovered_stuck_jobs", { count: result.rows.length })
  }
  await reopenCompletedCommandsWithPendingWork()
  return result.rows.length
}

/** Remove terminal schedules finished more than 36 hours ago (jobs cascade). */
export async function cleanupStaleScheduledCommands(workspaceId: string): Promise<number> {
  const result = await query<{ id: number }>(
    `DELETE FROM scheduled_publish_commands
     WHERE workspace_id = $1
       AND status IN ('completed', 'cancelled', 'failed')
       AND (
         (completed_at IS NOT NULL AND completed_at < NOW() - INTERVAL '36 hours')
         OR (cancelled_at IS NOT NULL AND cancelled_at < NOW() - INTERVAL '36 hours')
         OR (
           status = 'failed'
           AND completed_at IS NULL
           AND cancelled_at IS NULL
           AND updated_at < NOW() - INTERVAL '36 hours'
         )
       )
     RETURNING id`,
    [workspaceId]
  )
  return result.rows.length
}

export async function listScheduledCommands(
  workspaceId: string,
  opts: { storeCode?: string; status?: string; page?: number; limit?: number }
): Promise<ScheduleCommandListResponse> {
  try {
    await cleanupStaleScheduledCommands(workspaceId)
  } catch (e) {
    console.error("[scheduledPublish] cleanup stale commands failed:", e)
  }

  const page  = Math.max(1, opts.page ?? 1)
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50))
  const offset = (page - 1) * limit

  const conditions = ["workspace_id = $1"]
  const params: unknown[] = [workspaceId]
  let idx = 2

  if (opts.storeCode) {
    conditions.push(`store_code = $${idx++}`)
    params.push(opts.storeCode)
  }
  if (opts.status) {
    conditions.push(`status = $${idx++}`)
    params.push(opts.status)
  }

  const where = conditions.join(" AND ")

  const countResult = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM scheduled_publish_commands WHERE ${where}`,
    params
  )
  const total = parseInt(countResult.rows[0]?.cnt ?? "0", 10)

  const listResult = await query<CommandRow>(
    `SELECT id, store_code, title, status, selection_mode,
            requested_count, eligible_count, skipped_count, created_job_count,
            start_at::text, interval_seconds, quantity, title_mode,
            created_at::text, updated_at::text,
            paused_at::text, cancelled_at::text, completed_at::text,
            last_error, metadata
     FROM scheduled_publish_commands
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset]
  )

  const commands: ScheduledPublishCommand[] = []
  for (const row of listResult.rows) {
    const progress = await fetchJobProgress(row.id)
    commands.push(mapCommand(row, progress))
  }

  return { ok: true, page, limit, total, commands }
}

// ─── Command detail ───────────────────────────────────────────

export async function getScheduledCommandDetail(
  workspaceId: string,
  commandId:   number
): Promise<ScheduleCommandDetailResponse | null> {
  const row = await loadCommandRow(workspaceId, commandId)
  if (!row) return null

  const progress = await fetchJobProgress(commandId)
  const meta = row.metadata ?? {}
  const skipDetails = Array.isArray(meta.skipDetails) ? meta.skipDetails as ScheduleSkipDetail[] : undefined

  const jobsResult = await query<JobRow>(
    `SELECT id, command_id, pool_id, asin, scheduled_at::text, status,
            attempt_count, error_message, published_at::text, failed_at::text, cancelled_at::text
     FROM scheduled_publish_jobs
     WHERE command_id = $1
     ORDER BY scheduled_at ASC
     LIMIT 100`,
    [commandId]
  )

  return {
    ok: true,
    command: mapCommand(row, progress),
    skipDetails,
    recentJobs: jobsResult.rows.map(mapJob),
  }
}

// ─── Jobs list ────────────────────────────────────────────────

export async function listScheduledJobs(
  workspaceId: string,
  commandId:   number,
  opts: { status?: string; page?: number; limit?: number }
): Promise<ScheduleJobListResponse | null> {
  const row = await loadCommandRow(workspaceId, commandId)
  if (!row) return null

  const page  = Math.max(1, opts.page ?? 1)
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100))
  const offset = (page - 1) * limit

  const conditions = ["command_id = $1", "workspace_id = $2"]
  const params: unknown[] = [commandId, workspaceId]
  let idx = 3

  if (opts.status) {
    conditions.push(`status = $${idx++}`)
    params.push(opts.status)
  }

  const where = conditions.join(" AND ")

  const countResult = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM scheduled_publish_jobs WHERE ${where}`,
    params
  )
  const total = parseInt(countResult.rows[0]?.cnt ?? "0", 10)

  const jobsResult = await query<JobRow>(
    `SELECT id, command_id, pool_id, asin, scheduled_at::text, status,
            attempt_count, error_message, published_at::text, failed_at::text, cancelled_at::text
     FROM scheduled_publish_jobs
     WHERE ${where}
     ORDER BY scheduled_at ASC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset]
  )

  const progress = await fetchJobProgress(commandId)
  return {
    ok: true,
    command: mapCommand(row, progress),
    page,
    limit,
    total,
    jobs: jobsResult.rows.map(mapJob),
  }
}

// ─── Cancel / pause / resume ──────────────────────────────────

async function updateCommandStatus(
  workspaceId: string,
  commandId:   number,
  updates: {
    status:       string
    pausedAt?:    string | null
    cancelledAt?: string | null
  }
): Promise<ScheduledPublishCommand | null> {
  const row = await loadCommandRow(workspaceId, commandId)
  if (!row) return null

  const result = await query<CommandRow>(
    `UPDATE scheduled_publish_commands
     SET status = $3,
         paused_at = COALESCE($4::timestamptz, paused_at),
         cancelled_at = COALESCE($5::timestamptz, cancelled_at),
         updated_at = NOW()
     WHERE workspace_id = $1 AND id = $2
     RETURNING id, store_code, title, status, selection_mode,
               requested_count, eligible_count, skipped_count, created_job_count,
               start_at::text, interval_seconds, quantity, title_mode,
               created_at::text, updated_at::text,
               paused_at::text, cancelled_at::text, completed_at::text,
               last_error, metadata`,
    [
      workspaceId, commandId, updates.status,
      updates.pausedAt ?? null,
      updates.cancelledAt ?? null,
    ]
  )
  const updated = result.rows[0]
  if (!updated) return null
  const progress = await fetchJobProgress(commandId)
  return mapCommand(updated, progress)
}

export async function cancelScheduledCommand(
  workspaceId: string,
  commandId:   number
): Promise<ScheduleCommandActionResponse | null> {
  const row = await loadCommandRow(workspaceId, commandId)
  if (!row) return null

  await query(
    `UPDATE scheduled_publish_jobs
     SET status = 'cancelled',
         cancelled_at = NOW(),
         updated_at = NOW()
     WHERE command_id = $1
       AND workspace_id = $2
       AND status = 'scheduled'`,
    [commandId, workspaceId]
  )

  const command = await updateCommandStatus(workspaceId, commandId, {
    status: "cancelled",
    cancelledAt: new Date().toISOString(),
  })
  if (!command) return null
  return { ok: true, command }
}

export async function pauseScheduledCommand(
  workspaceId: string,
  commandId:   number
): Promise<ScheduleCommandActionResponse | null> {
  const row = await loadCommandRow(workspaceId, commandId)
  if (!row) return null
  if (row.status === "cancelled" || row.status === "completed") {
    throw new Error(`Cannot pause command in status: ${row.status}`)
  }

  const command = await updateCommandStatus(workspaceId, commandId, {
    status: "paused",
    pausedAt: new Date().toISOString(),
  })
  if (!command) return null
  return { ok: true, command }
}

export async function resumeScheduledCommand(
  workspaceId: string,
  commandId:   number
): Promise<ScheduleCommandActionResponse | null> {
  const row = await loadCommandRow(workspaceId, commandId)
  if (!row) return null
  if (row.status !== "paused") {
    throw new Error(`Command is not paused (status: ${row.status})`)
  }

  const result = await query<CommandRow>(
    `UPDATE scheduled_publish_commands
     SET status = 'scheduled',
         paused_at = NULL,
         updated_at = NOW()
     WHERE workspace_id = $1 AND id = $2
     RETURNING id, store_code, title, status, selection_mode,
               requested_count, eligible_count, skipped_count, created_job_count,
               start_at::text, interval_seconds, quantity, title_mode,
               created_at::text, updated_at::text,
               paused_at::text, cancelled_at::text, completed_at::text,
               last_error, metadata`,
    [workspaceId, commandId]
  )
  const updated = result.rows[0]
  if (!updated) return null
  const progress = await fetchJobProgress(commandId)
  return { ok: true, command: mapCommand(updated, progress) }
}
