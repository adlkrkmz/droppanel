// ----------------------------------------------------------------
// scheduledPublishAutoRunnerService.ts — simulation-only auto tick loop
// ----------------------------------------------------------------

import { runDueSimulation } from "./scheduledPublishRunnerService"
import type {
  ScheduledSimulationAutoRunnerLastResult,
  ScheduledSimulationAutoRunnerStatus,
} from "./scheduledPublishTypes"

const DEFAULT_INTERVAL_MS = 30_000
const MIN_INTERVAL_MS     = 10_000
const AUTO_TICK_LIMIT     = 20

function resolveIntervalMs(): number {
  const raw = process.env.SCHEDULED_PUBLISH_SIM_RUNNER_INTERVAL_MS
  if (!raw) return DEFAULT_INTERVAL_MS
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < MIN_INTERVAL_MS) return DEFAULT_INTERVAL_MS
  return n
}

let intervalHandle: ReturnType<typeof setInterval> | null = null
let workspaceId:    string | null = null
let intervalMs:     number = DEFAULT_INTERVAL_MS
let enabled = false
let running = false
let tickInProgress = false
let lastTickAt: string | null = null
let lastResult: ScheduledSimulationAutoRunnerLastResult | null = null
let lastError:  string | null = null

async function runTick(): Promise<void> {
  if (tickInProgress || !workspaceId) return

  tickInProgress = true
  try {
    const result = await runDueSimulation(workspaceId, { limit: AUTO_TICK_LIMIT })
    lastTickAt = new Date().toISOString()
    lastResult = {
      processed: result.processed,
      simulated: result.simulated,
      skipped:   result.skipped,
      failed:    result.failed,
    }
    lastError = null

    if (result.processed > 0) {
      console.log(
        `[ScheduledPublishSimRunner] tick processed=${result.processed} simulated=${result.simulated} skipped=${result.skipped} failed=${result.failed}`
      )
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    lastTickAt = new Date().toISOString()
    lastError = msg.slice(0, 500)
    console.error("[ScheduledPublishSimRunner] tick error:", msg)
  } finally {
    tickInProgress = false
  }
}

export function startScheduledPublishSimulationAutoRunner(wsId: string): void {
  if (running) return

  workspaceId = wsId
  intervalMs = resolveIntervalMs()
  enabled = true
  running = true

  void runTick()

  intervalHandle = setInterval(() => {
    void runTick()
  }, intervalMs)

  console.log(
    `[ScheduledPublishSimRunner] Started (interval ${intervalMs / 1000}s, simulation-only, limit ${AUTO_TICK_LIMIT})`
  )
}

export function stopScheduledPublishSimulationAutoRunner(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  running = false
  enabled = false
  console.log("[ScheduledPublishSimRunner] Stopped")
}

export function getScheduledPublishSimulationAutoRunnerStatus(): ScheduledSimulationAutoRunnerStatus {
  return {
    enabled,
    running,
    intervalMs,
    tickInProgress,
    lastTickAt,
    lastResult,
    lastError,
  }
}
