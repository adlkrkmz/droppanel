// ----------------------------------------------------------------
// scheduledPublishCleanupSchedulerService.ts — periodic stale command cleanup
// ----------------------------------------------------------------

import { cleanupStaleScheduledCommands } from "./scheduledPublishService"

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

let intervalHandle: ReturnType<typeof setInterval> | null = null
let workspaceId:    string | null = null
let running = false
let cleanupInProgress = false

export async function runScheduledPublishCleanup(wsId: string): Promise<number> {
  const deleted = await cleanupStaleScheduledCommands(wsId)
  console.log("[ScheduledPublishCleanup] done", {
    deleted,
    olderThanHours: 36,
  })
  return deleted
}

async function runCleanupTick(): Promise<void> {
  if (cleanupInProgress || !workspaceId) return

  cleanupInProgress = true
  try {
    await runScheduledPublishCleanup(workspaceId)
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    console.error("[ScheduledPublishCleanup] error", {
      message: error.message,
      stack:   error.stack,
    })
  } finally {
    cleanupInProgress = false
  }
}

export function startScheduledPublishCleanupScheduler(wsId: string): void {
  if (running) return

  workspaceId = wsId
  running = true

  void runCleanupTick()

  intervalHandle = setInterval(() => {
    void runCleanupTick()
  }, CLEANUP_INTERVAL_MS)

  console.log("[ScheduledPublishCleanup] scheduler started", {
    intervalMs: CLEANUP_INTERVAL_MS,
  })
}

export function stopScheduledPublishCleanupScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  running = false
}
