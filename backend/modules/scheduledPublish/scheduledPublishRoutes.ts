// ----------------------------------------------------------------
// scheduledPublishRoutes.ts — admin HTTP handlers
// ----------------------------------------------------------------

import type { AdminRequest, AdminResponse } from "../admin/adminTypes"
import { parseTitleMode } from "../titleBot/titleBotService"
import {
  cancelScheduledCommand,
  createScheduledPublish,
  getScheduledCommandDetail,
  listScheduledCommands,
  listScheduledJobs,
  pauseScheduledCommand,
  resumeScheduledCommand,
} from "./scheduledPublishService"
import { runDueSimulation } from "./scheduledPublishRunnerService"
import { runLiveOneDueJob } from "./scheduledPublishLiveRunnerService"
import { getScheduledPublishSimulationAutoRunnerStatus } from "./scheduledPublishAutoRunnerService"
import { createQuickDispatchWithEvidenceGate } from "./quickDispatchEvidenceGateService"
import type {
  ScheduleCommandActionResponse,
  ScheduleCommandDetailResponse,
  ScheduleCommandListResponse,
  ScheduleExecutionMode,
  ScheduleJobListResponse,
  SchedulePublishResponse,
  ScheduleSelectionMode,
  ScheduledLiveRunnerRunResponse,
  ScheduledRunnerRunDueResponse,
  ScheduledRunnerStatusResponse,
} from "./scheduledPublishTypes"

const SCHEDULE_POOL_IDS_MAX = 500
const SCHEDULE_COUNT_MAX    = 500

function resolveLiveMax(): number {
  const raw = process.env.SCHEDULE_LIVE_MAX
  if (!raw) return SCHEDULE_COUNT_MAX
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 1 ? Math.min(n, SCHEDULE_COUNT_MAX) : SCHEDULE_COUNT_MAX
}

function getWorkspaceId(): string {
  const id = process.env.WORKSPACE_ID
  if (!id) throw new Error("WORKSPACE_ID is not defined in environment")
  return id
}

function bad(message: string): AdminResponse<never> {
  return { status: 400, body: { error: "BadRequest", message } }
}

function notFound(message: string): AdminResponse<never> {
  return { status: 404, body: { error: "NotFound", message } }
}

function err(message: string): AdminResponse<never> {
  return { status: 500, body: { error: "InternalServerError", message } }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 1 ? n : fallback
}

function parseCommandId(req: AdminRequest): number | null {
  const raw = req.params.id
  if (!raw) return null
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 1 ? n : null
}

function parsePoolIdList(raw: unknown, max: number): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const ids = [...new Set(
    raw.map(id => Number(id)).filter(id => Number.isInteger(id) && id >= 1)
  )]
  if (ids.length === 0) return null
  if (ids.length > max) return null
  return ids
}

function validateLiveConfirmation(body: Record<string, unknown>): AdminResponse<never> | null {
  if (body.confirm !== true) {
    return bad("Live operation requires confirmation.")
  }
  return null
}

export async function handlePostSchedulePublish(
  req: AdminRequest
): Promise<AdminResponse<SchedulePublishResponse>> {
  try {
    const body = req.body as Record<string, unknown>
    const storeCode = typeof body.storeCode === "string" ? body.storeCode.trim() : ""
    if (!storeCode) return bad("storeCode is required")

    const selectionMode = (typeof body.selectionMode === "string"
      ? body.selectionMode.trim().toLowerCase()
      : "ready_next") as ScheduleSelectionMode
    if (selectionMode !== "ready_next" && selectionMode !== "selected") {
      return bad("selectionMode must be ready_next or selected")
    }

    let executionMode: ScheduleExecutionMode = "simulation"
    if (body.executionMode != null) {
      const rawMode = typeof body.executionMode === "string" ? body.executionMode.trim().toLowerCase() : ""
      if (rawMode === "live") executionMode = "live"
      else if (rawMode !== "simulation" && rawMode !== "") {
        return bad("executionMode must be simulation or live")
      }
    }

    if (executionMode === "live") {
      const liveErr = validateLiveConfirmation(body)
      if (liveErr) return liveErr
    }

    const liveMax = resolveLiveMax()
    const countMax = executionMode === "live" ? liveMax : SCHEDULE_COUNT_MAX
    const poolIdsMax = executionMode === "live" ? liveMax : SCHEDULE_POOL_IDS_MAX

    const count = Number(body.count)
    if (!Number.isInteger(count) || count < 1 || count > countMax) {
      return bad(`count must be an integer between 1 and ${countMax}`)
    }

    let poolIds: number[] | undefined
    if (selectionMode === "selected") {
      const parsed = parsePoolIdList(body.poolIds, poolIdsMax)
      if (!parsed) {
        return bad(`poolIds must be a non-empty array of integers (max ${poolIdsMax})`)
      }
      poolIds = parsed
    }

    const startAtRaw = typeof body.startAt === "string" ? body.startAt.trim() : ""
    if (!startAtRaw) return bad("startAt is required")
    const startDate = new Date(startAtRaw)
    if (Number.isNaN(startDate.getTime())) return bad("startAt must be a valid ISO datetime")

    const intervalSeconds = Number(body.intervalSeconds)
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 86400) {
      return bad("intervalSeconds must be an integer between 30 and 86400")
    }

    const quantity = body.quantity != null ? Number(body.quantity) : 1
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      return bad("quantity must be an integer between 1 and 10")
    }

    const titleMode = parseTitleMode(
      typeof body.titleMode === "string" ? body.titleMode : undefined,
      body.useAiTitle as boolean | undefined
    )

    const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : undefined
    const evidenceGate = body.evidenceGate !== false

    const scheduleReq = {
      storeCode,
      selectionMode,
      poolIds,
      count,
      startAt: startDate.toISOString(),
      intervalSeconds,
      quantity,
      titleMode,
      title: title || undefined,
      executionMode,
      evidenceGate,
    }

    const result = evidenceGate
      ? await createQuickDispatchWithEvidenceGate(getWorkspaceId(), scheduleReq)
      : await createScheduledPublish(getWorkspaceId(), scheduleReq)

    return { status: 200, body: result }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("Store not found")) return notFound(msg)
    if (msg.includes("not active")) return bad(msg)
    if (msg.includes("No eligible pool items")) {
      const skipDetails = (e as Error & { skipDetails?: unknown }).skipDetails
      return {
        status: 400,
        body: {
          error: "no_eligible_pool_items",
          message: msg,
          skipDetails,
        } as unknown as SchedulePublishResponse,
      }
    }
    console.error("[ADMIN schedule-publish]", e)
    return err(msg)
  }
}

export async function handleGetScheduleCommands(
  req: AdminRequest
): Promise<AdminResponse<ScheduleCommandListResponse>> {
  try {
    const { storeCode, status, page, limit } = req.query
    const body = await listScheduledCommands(getWorkspaceId(), {
      storeCode: storeCode || undefined,
      status:    status || undefined,
      page:      parsePositiveInt(page, 1),
      limit:     Math.min(100, parsePositiveInt(limit, 50)),
    })
    return { status: 200, body }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handleGetScheduleCommandById(
  req: AdminRequest
): Promise<AdminResponse<ScheduleCommandDetailResponse>> {
  try {
    const commandId = parseCommandId(req)
    if (!commandId) return bad("Invalid command id")

    const body = await getScheduledCommandDetail(getWorkspaceId(), commandId)
    if (!body) return notFound("Schedule command not found")
    return { status: 200, body }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handleGetScheduleCommandJobs(
  req: AdminRequest
): Promise<AdminResponse<ScheduleJobListResponse>> {
  try {
    const commandId = parseCommandId(req)
    if (!commandId) return bad("Invalid command id")

    const { status, page, limit } = req.query
    const body = await listScheduledJobs(getWorkspaceId(), commandId, {
      status: status || undefined,
      page:   parsePositiveInt(page, 1),
      limit:  Math.min(200, parsePositiveInt(limit, 100)),
    })
    if (!body) return notFound("Schedule command not found")
    return { status: 200, body }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostScheduleCommandCancel(
  req: AdminRequest
): Promise<AdminResponse<ScheduleCommandActionResponse>> {
  try {
    const commandId = parseCommandId(req)
    if (!commandId) return bad("Invalid command id")

    const body = await cancelScheduledCommand(getWorkspaceId(), commandId)
    if (!body) return notFound("Schedule command not found")
    return { status: 200, body }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostScheduleCommandPause(
  req: AdminRequest
): Promise<AdminResponse<ScheduleCommandActionResponse>> {
  try {
    const commandId = parseCommandId(req)
    if (!commandId) return bad("Invalid command id")

    const body = await pauseScheduledCommand(getWorkspaceId(), commandId)
    if (!body) return notFound("Schedule command not found")
    return { status: 200, body }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostScheduleCommandResume(
  req: AdminRequest
): Promise<AdminResponse<ScheduleCommandActionResponse>> {
  try {
    const commandId = parseCommandId(req)
    if (!commandId) return bad("Invalid command id")

    const body = await resumeScheduledCommand(getWorkspaceId(), commandId)
    if (!body) return notFound("Schedule command not found")
    return { status: 200, body }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostScheduleRunnerRunDue(
  req: AdminRequest
): Promise<AdminResponse<ScheduledRunnerRunDueResponse>> {
  try {
    const body = req.body as Record<string, unknown>
    const limitRaw = body.limit != null ? Number(body.limit) : 5
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 20) {
      return bad("limit must be an integer between 1 and 20")
    }

    const storeCode = typeof body.storeCode === "string" && body.storeCode.trim()
      ? body.storeCode.trim()
      : undefined

    const result = await runDueSimulation(getWorkspaceId(), {
      limit: limitRaw,
      storeCode,
    })
    return { status: 200, body: result }
  } catch (e) {
    console.error("[ADMIN schedule-runner/run-due]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handleGetScheduleRunnerStatus(
  _req: AdminRequest
): Promise<AdminResponse<ScheduledRunnerStatusResponse>> {
  return {
    status: 200,
    body: {
      ok: true,
      simulationRunner: getScheduledPublishSimulationAutoRunnerStatus(),
    },
  }
}

export async function handlePostScheduleRunnerRunLiveOne(
  req: AdminRequest
): Promise<AdminResponse<ScheduledLiveRunnerRunResponse>> {
  try {
    const body = req.body as Record<string, unknown>
    const liveErr = validateLiveConfirmation(body)
    if (liveErr) return liveErr

    const storeCode = typeof body.storeCode === "string" && body.storeCode.trim()
      ? body.storeCode.trim()
      : undefined

    let commandId: number | undefined
    if (body.commandId != null) {
      const n = Number(body.commandId)
      if (!Number.isInteger(n) || n < 1) return bad("commandId must be a positive integer")
      commandId = n
    }

    const result = await runLiveOneDueJob(getWorkspaceId(), {
      storeCode,
      commandId,
    })
    return { status: 200, body: result }
  } catch (e) {
    console.error("[ADMIN schedule-runner/run-live-one]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}
