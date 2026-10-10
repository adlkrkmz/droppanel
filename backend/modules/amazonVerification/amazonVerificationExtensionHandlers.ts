import type { AuthedRequest } from "../auth/authMiddleware"
import { getAuthenticatedWorkspaceId } from "../app/appOwnership"
import { AppHttpError } from "../app/appTypes"
import { upsertExtensionHeartbeat } from "./extensionWorkerRegistry"
import {
  claimNextVerificationTask,
  failVerificationTask,
  markVerificationRunning,
  submitVerificationResult,
} from "./amazonVerificationQueue"
import { getTenantExtensionWorkerStatus } from "./amazonVerificationAdminStatus"
import { loadAmazonVerificationConfig } from "./amazonVerificationConfig"

function actor(req: AuthedRequest): { workspaceId: string; userId: string } {
  const workspaceId = getAuthenticatedWorkspaceId(req)
  const userId = req.auth?.user?.id
  if (!userId) throw new AppHttpError(401, "Unauthorized")
  return { workspaceId, userId }
}

function httpErr(e: unknown): never {
  const status = e && typeof e === "object" && "status" in e ? Number((e as { status: unknown }).status) : 0
  throw new AppHttpError(status >= 400 && status < 600 ? status : 500, e instanceof Error ? e.message : String(e))
}

export async function handleExtensionWorkerHeartbeat(req: AuthedRequest, body: Record<string, unknown>) {
  const { workspaceId, userId } = actor(req)
  const deviceId = String(body.deviceId ?? "").trim()
  if (!deviceId) throw new AppHttpError(400, "deviceId is required")
  const worker = await upsertExtensionHeartbeat({
    userId,
    workspaceId,
    deviceId,
    extensionVersion: typeof body.extensionVersion === "string" ? body.extensionVersion : null,
    amazonAvailable: typeof body.amazonAvailable === "boolean" ? body.amazonAvailable : null,
    activeTaskId: body.activeTaskId != null ? Number(body.activeTaskId) : null,
  })
  const cfg = loadAmazonVerificationConfig()
  return {
    ok: true,
    workerId: worker.workerId,
    online: true,
    heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
    leaseSeconds: cfg.leaseSeconds,
    maxConcurrentTasks: cfg.maxConcurrentTasksPerWorker,
  }
}

export async function handleExtensionWorkerStatus(req: AuthedRequest) {
  const { workspaceId, userId } = actor(req)
  return { ok: true, ...(await getTenantExtensionWorkerStatus({ workspaceId, userId })) }
}

export async function handleClaimNextVerification(req: AuthedRequest, body: Record<string, unknown>) {
  const cfg = loadAmazonVerificationConfig()
  if (cfg.serverBrowserPrimary && !cfg.extensionFallbackEnabled) {
    return { ok: true, task: null, message: "NO_WORK" }
  }
  const { workspaceId, userId } = actor(req)
  const deviceId = String(body.deviceId ?? "").trim()
  if (!deviceId) throw new AppHttpError(400, "deviceId is required")
  const hb = await upsertExtensionHeartbeat({
    userId,
    workspaceId,
    deviceId,
    extensionVersion: typeof body.extensionVersion === "string" ? body.extensionVersion : null,
    amazonAvailable: typeof body.amazonAvailable === "boolean" ? body.amazonAvailable : null,
  })
  const claimed = await claimNextVerificationTask({
    workspaceId,
    userId,
    workerId: hb.workerId,
  })
  if (!claimed.task) return { ok: true, task: null, message: "NO_WORK" }
  return {
    ok: true,
    task: {
      taskId: claimed.task.id,
      asin: claimed.task.asin,
      amazonUrl: claimed.task.amazonUrl,
      reason: claimed.task.reason,
      leaseExpiresAt: claimed.task.leaseExpiresAt,
    },
    workerId: hb.workerId,
  }
}

export async function handleVerificationStart(req: AuthedRequest, taskIdRaw: string, body: Record<string, unknown>) {
  const { workspaceId, userId } = actor(req)
  const taskId = Number(taskIdRaw)
  if (!Number.isFinite(taskId) || taskId <= 0) throw new AppHttpError(400, "taskId is required")
  const workerId = String(body.workerId ?? "").trim()
  if (!workerId) throw new AppHttpError(400, "workerId is required")
  const ok = await markVerificationRunning({ taskId, workspaceId, userId, workerId })
  if (!ok) throw new AppHttpError(409, "Task is not claimed by this worker")
  return { ok: true, status: "RUNNING" }
}

export async function handleVerificationResult(req: AuthedRequest, taskIdRaw: string, body: Record<string, unknown>) {
  const { workspaceId, userId } = actor(req)
  const taskId = Number(taskIdRaw)
  if (!Number.isFinite(taskId) || taskId <= 0) throw new AppHttpError(400, "taskId is required")
  const workerId = String(body.workerId ?? "").trim()
  if (!workerId) throw new AppHttpError(400, "workerId is required")
  try {
    return await submitVerificationResult({
      taskId,
      workspaceId,
      userId,
      workerId,
      payload: (body.result && typeof body.result === "object" ? body.result : body) as import("./amazonVerificationQueue").VerificationResultPayload,
    })
  } catch (e) {
    httpErr(e)
  }
}

export async function handleVerificationFail(req: AuthedRequest, taskIdRaw: string, body: Record<string, unknown>) {
  const { workspaceId, userId } = actor(req)
  const taskId = Number(taskIdRaw)
  if (!Number.isFinite(taskId) || taskId <= 0) throw new AppHttpError(400, "taskId is required")
  const workerId = String(body.workerId ?? "").trim()
  if (!workerId) throw new AppHttpError(400, "workerId is required")
  try {
    return await failVerificationTask({
      taskId,
      workspaceId,
      userId,
      workerId,
      code: String(body.errorCode ?? body.code ?? "EXTRACTOR_FAILED"),
      message: String(body.errorMessage ?? body.message ?? "verification failed"),
    })
  } catch (e) {
    httpErr(e)
  }
}
