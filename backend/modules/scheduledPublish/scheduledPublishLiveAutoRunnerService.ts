// ----------------------------------------------------------------
// scheduledPublishLiveAutoRunnerService.ts — backend live schedule tick
// ----------------------------------------------------------------

import { query } from "../../db/client"
import {
  recoverStuckLiveJobs,
  reopenCompletedCommandsWithPendingWork,
} from "./scheduledPublishService"
import { runLiveOneDueJob } from "./scheduledPublishLiveRunnerService"

const DEFAULT_INTERVAL_MS = 5_000
const MIN_INTERVAL_MS     = 3_000
const MAX_JOBS_PER_WORKSPACE_PER_TICK = 3

function resolveIntervalMs(): number {
  const raw = process.env.SCHEDULED_PUBLISH_LIVE_RUNNER_INTERVAL_MS
  if (!raw) return DEFAULT_INTERVAL_MS
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < MIN_INTERVAL_MS) return DEFAULT_INTERVAL_MS
  return n
}

let intervalHandle: ReturnType<typeof setInterval> | null = null
let intervalMs:     number = DEFAULT_INTERVAL_MS
let running = false
let tickInProgress = false

async function resolveWorkspaceIdsForRunner(): Promise<string[]> {
  const fromSchedules = await query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id::text AS workspace_id
     FROM scheduled_publish_commands
     WHERE status IN ('scheduled', 'running')
       AND COALESCE(metadata->>'executionMode', 'simulation') = 'live'`
  )
  const ids = fromSchedules.rows.map((r) => r.workspace_id).filter(Boolean)
  if (ids.length > 0) return ids

  const envId = process.env.WORKSPACE_ID?.trim()
  if (envId) return [envId]

  try {
    const fromWorkspaces = await query<{ id: string }>(
      `SELECT id::text AS id FROM workspaces WHERE COALESCE(status, 'active') = 'active'`
    )
    const wsIds = fromWorkspaces.rows.map((r) => r.id).filter(Boolean)
    if (wsIds.length > 0) return wsIds
  } catch {
    /* workspaces.status column may be missing on older DBs */
  }

  return []
}

async function runTick(): Promise<void> {
  if (tickInProgress) return

  tickInProgress = true
  let jobsProcessed = 0
  let skipped = 0
  let failed = 0
  let commandCount = 0

  try {
    await reopenCompletedCommandsWithPendingWork()
    try {
      const { processDuePromotionRetries } = await import("../ebay/ebayPromotedAdService")
      await processDuePromotionRetries(3)
    } catch (e) {
      console.error("[PromotionRetry] tick failed", e instanceof Error ? e.message : String(e))
    }
    const workspaceIds = await resolveWorkspaceIdsForRunner()
    commandCount = workspaceIds.length

    for (const wsId of workspaceIds) {
      for (let i = 0; i < MAX_JOBS_PER_WORKSPACE_PER_TICK; i++) {
        const result = await runLiveOneDueJob(wsId, {})
        if (result.processed === 0) break
        jobsProcessed += result.processed
        skipped += result.skipped
        failed += result.failed
      }
    }

    if (commandCount > 0 || jobsProcessed > 0) {
      console.log("[BulkJobRunner] tick", {
        commandCount,
        itemsProcessed: jobsProcessed,
        skipped,
        failed,
      })
      console.log("[ScheduledPublishRunner] tick", {
        workspaceCount: commandCount,
        processed: jobsProcessed,
        skipped,
        failed,
      })
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    console.error("[BulkJobRunner] error", { message: error.message })
    console.error("[ScheduledPublishRunner] error", {
      message: error.message,
      stack:   error.stack,
    })
  } finally {
    tickInProgress = false
  }
}

export function startScheduledPublishLiveAutoRunner(): void {
  if (running) return

  intervalMs = resolveIntervalMs()
  running = true

  console.log("[ScheduledPublishRunner] startup", { intervalMs })

  void recoverStuckLiveJobs().then(() => runTick())

  intervalHandle = setInterval(() => {
    void runTick()
  }, intervalMs)
}

/**
 * Soft wake for the existing live runner after a publish job is created/due.
 * Does not create a second publisher — only schedules runTick() soon if idle.
 * Multiple wakes are allowed; tickInProgress prevents overlapping execution.
 */
export function wakeScheduledPublishLiveRunner(delayMs = 0): void {
  if (!running) return
  const wait = Math.max(0, Math.min(Number(delayMs) || 0, 60_000))
  setTimeout(() => {
    void runTick()
  }, wait)
}

export function stopScheduledPublishLiveAutoRunner(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  running = false
  console.log("[ScheduledPublishRunner] stopped")
}
