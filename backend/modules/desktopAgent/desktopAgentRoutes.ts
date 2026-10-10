import type { Express, Request, Response } from "express"
import type { AuthedRequest } from "../auth/authMiddleware"
import { requireAuth, requireActiveUser } from "../auth/authMiddleware"
import { getAuthenticatedWorkspaceId } from "../app/appOwnership"
import { AppHttpError } from "../app/appTypes"
import { consumeNamedRateLimit } from "../security/httpSecurity"
import {
  listDesktopAgentDevicesForWorkspace,
  recordDesktopAgentHeartbeat,
  registerDesktopAgentDevice,
  resolveDesktopAgentAuth,
  revokeDesktopAgentDevice,
} from "./desktopAgentAuth"
import { listDesktopAgentAsins } from "./desktopAgentAsins"
import { handleDesktopFailure, handleDesktopObservation } from "./desktopAgentObservation"
import { claimDesktopAgentPairing, createDesktopAgentPairing } from "./desktopAgentPairing"
import type { DesktopAgentDeviceRow } from "./desktopAgentTypes"

function sendError(res: Response, e: unknown): void {
  if (e instanceof AppHttpError) {
    res.status(e.status).json({ ok: false, error: e.message })
    return
  }
  const status =
    e && typeof e === "object" && "status" in e && typeof (e as { status: unknown }).status === "number"
      ? (e as { status: number }).status
      : 500
  const code =
    e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined
  const deferUntil =
    code === "TASK_DEFERRED" &&
    e &&
    typeof e === "object" &&
    "deferUntil" in e &&
    typeof (e as { deferUntil: unknown }).deferUntil === "string"
      ? (e as { deferUntil: string }).deferUntil
      : undefined
  const message = e instanceof Error ? e.message : "Internal error"
  if (status >= 500) console.error("[DesktopAgent]", e)
  res.status(status).json({
    ok: false,
    error: process.env.NODE_ENV === "production" && status >= 500 ? "INTERNAL_ERROR" : message,
    ...(code ? { code } : {}),
    ...(deferUntil ? { deferUntil } : {}),
  })
}

async function withSessionUser(
  req: Request,
  res: Response,
  fn: (r: AuthedRequest) => Promise<void>
): Promise<void> {
  await requireAuth(req as AuthedRequest, res, async () => {
    await requireActiveUser(req as AuthedRequest, res, async () => {
      try {
        await fn(req as AuthedRequest)
      } catch (e) {
        sendError(res, e)
      }
    })
  })
}

async function withDevice(
  req: Request,
  res: Response,
  fn: (device: DesktopAgentDeviceRow, body: Record<string, unknown>) => Promise<void>
): Promise<void> {
  try {
    const device = await resolveDesktopAgentAuth(req)
    if (!device) {
      res.status(401).json({ ok: false, error: "Desktop Agent authentication required" })
      return
    }
    await fn(device, (req.body ?? {}) as Record<string, unknown>)
  } catch (e) {
    sendError(res, e)
  }
}

function mapDevicePublic(d: DesktopAgentDeviceRow & { online: boolean }) {
  return {
    deviceId: d.deviceId,
    deviceName: d.deviceName,
    status: d.status,
    online: d.online,
    version: d.version,
    lastHeartbeatAt: d.lastHeartbeatAt?.toISOString() ?? null,
    lastObservationAt: d.lastObservationAt?.toISOString() ?? null,
    successfulObservationsToday: d.successCountToday,
    technicalFailuresToday: d.failureCountToday,
    scannedCount: d.scannedCount,
    createdAt: d.createdAt.toISOString(),
  }
}

export function registerDesktopAgentRoutes(app: Express): void {
  /** Session: create one-time pairing code for current workspace. */
  app.post("/api/desktop-agent/pairing/create", (req, res) =>
    withSessionUser(req, res, async authed => {
      const workspaceId = getAuthenticatedWorkspaceId(authed)
      const userId = authed.auth!.user.id
      const limit = consumeNamedRateLimit({
        name: "desktop-agent-pairing-create",
        key: `user:${userId}|ws:${workspaceId}`,
        windowMs: 15 * 60_000,
        max: 10,
      })
      res.setHeader("RateLimit-Limit", String(limit.limit))
      res.setHeader("RateLimit-Remaining", String(limit.remaining))
      if (!limit.allowed) {
        res.setHeader("Retry-After", String(limit.retryAfterSec))
        res.status(429).json({
          ok: false,
          error: "RATE_LIMITED",
          message: "Too many pairing codes. Try again in a few minutes.",
        })
        return
      }
      const created = await createDesktopAgentPairing({ workspaceId, userId })
      res.status(201).json({
        ok: true,
        pairingCode: created.pairingCode,
        expiresAt: created.expiresAt,
        expiresInSeconds: 600,
      })
    })
  )

  /**
   * No session. Pairing-code protected.
   * Returns one-time device token; server stores token_hash only.
   * IP claim limiter is applied in httpServer (isolated bucket).
   */
  app.post("/api/desktop-agent/pairing/claim", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const pairingCode = String(body.pairingCode ?? "")
      const result = await claimDesktopAgentPairing({
        pairingCode,
        deviceName: body.deviceName != null ? String(body.deviceName) : undefined,
        version: body.version != null ? String(body.version) : null,
      })
      if (!result.ok) {
        const status =
          result.code === "EXPIRED" || result.code === "ALREADY_CLAIMED" || result.code === "CLAIM_RACE"
            ? 409
            : 400
        res.status(status).json({ ok: false, error: result.message, code: result.code })
        return
      }
      res.status(201).json({
        ok: true,
        deviceId: result.device.deviceId,
        deviceName: result.device.deviceName,
        workspaceId: result.device.workspaceId,
        token: result.plainToken,
        tokenHint: "Store locally; server keeps only token_hash",
      })
    } catch (e) {
      sendError(res, e)
    }
  })

  /** Session-authenticated legacy mint (kept; pairing is preferred). */
  app.post("/api/desktop-agent/register", (req, res) =>
    withSessionUser(req, res, async authed => {
      const workspaceId = getAuthenticatedWorkspaceId(authed)
      const userId = authed.auth!.user.id
      const body = (req.body ?? {}) as { deviceName?: string; version?: string }
      const { device, plainToken } = await registerDesktopAgentDevice({
        workspaceId,
        userId,
        deviceName: body.deviceName,
        version: body.version,
      })
      res.status(201).json({
        ok: true,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        workspaceId: device.workspaceId,
        token: plainToken,
        tokenHint: "Store locally; server keeps only token_hash",
      })
    })
  )

  app.post("/api/desktop-agent/heartbeat", (req, res) =>
    withDevice(req, res, async (device, body) => {
      const deviceId = String(body.deviceId ?? device.deviceId)
      if (deviceId !== device.deviceId) {
        throw Object.assign(new Error("deviceId mismatch"), { status: 403 })
      }
      const updated = await recordDesktopAgentHeartbeat({
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        version: body.version != null ? String(body.version) : null,
        scannedCount: typeof body.scannedCount === "number" ? body.scannedCount : null,
        workerState: body.workerState != null ? String(body.workerState) : null,
        metrics:
          body.metrics && typeof body.metrics === "object"
            ? (body.metrics as Record<string, unknown>)
            : body.ram != null || body.cpu != null
              ? { ram: body.ram ?? null, cpu: body.cpu ?? null }
              : null,
      })
      res.json({
        ok: true,
        deviceId: updated.deviceId,
        status: updated.status,
        lastHeartbeatAt: updated.lastHeartbeatAt?.toISOString() ?? null,
      })
    })
  )

  app.get("/api/desktop-agent/asins", (req, res) =>
    withDevice(req, res, async device => {
      const asins = await listDesktopAgentAsins(device.workspaceId)
      res.json({
        ok: true,
        workspaceId: device.workspaceId,
        count: asins.length,
        asins,
      })
    })
  )

  app.post("/api/desktop-agent/observation", (req, res) =>
    withDevice(req, res, async (device, body) => {
      const result = await handleDesktopObservation({ device, body })
      res.json(result)
    })
  )

  app.post("/api/desktop-agent/failure", (req, res) =>
    withDevice(req, res, async (device, body) => {
      const result = await handleDesktopFailure({ device, body })
      res.json(result)
    })
  )

  /** Session: list devices for Settings UI. */
  app.get("/api/desktop-agent/devices", (req, res) =>
    withSessionUser(req, res, async authed => {
      const workspaceId = getAuthenticatedWorkspaceId(authed)
      const devices = await listDesktopAgentDevicesForWorkspace(workspaceId)
      res.json({
        ok: true,
        workspaceId,
        devices: devices.map(mapDevicePublic),
      })
    })
  )

  /** Session: revoke/disconnect device in this workspace only. */
  app.post("/api/desktop-agent/devices/:deviceId/disconnect", (req, res) =>
    withSessionUser(req, res, async authed => {
      const workspaceId = getAuthenticatedWorkspaceId(authed)
      const deviceId = String(req.params.deviceId ?? "").trim()
      if (!deviceId) throw new AppHttpError(400, "deviceId is required")
      const result = await revokeDesktopAgentDevice({ workspaceId, deviceId })
      if (!result.ok) {
        res.status(404).json({ ok: false, error: "Device not found", code: "NOT_FOUND" })
        return
      }
      res.json({ ok: true, deviceId: result.deviceId, status: "REVOKED" })
    })
  )

  /** Read-only workspace admin observability (session). */
  app.get("/api/desktop-agent/admin/devices", (req, res) =>
    withSessionUser(req, res, async authed => {
      const workspaceId = getAuthenticatedWorkspaceId(authed)
      const devices = await listDesktopAgentDevicesForWorkspace(workspaceId)
      res.json({
        ok: true,
        workspaceId,
        devices: devices.map(mapDevicePublic),
      })
    })
  )
}
