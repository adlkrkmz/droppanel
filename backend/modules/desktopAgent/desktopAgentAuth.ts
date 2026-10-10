import crypto from "crypto"
import type { Request } from "express"
import { query } from "../../db/client"
import type { DesktopAgentDeviceRow, DesktopAgentDeviceStatus } from "./desktopAgentTypes"

const TOKEN_PREFIX = "ljda_"
const OFFLINE_AFTER_MS = 2 * 60_000

export function hashDesktopAgentToken(plainToken: string): string {
  return crypto.createHash("sha256").update(plainToken, "utf8").digest("hex")
}

export function generateDesktopAgentToken(): { plainToken: string; tokenHash: string } {
  const plainToken = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("hex")}`
  return { plainToken, tokenHash: hashDesktopAgentToken(plainToken) }
}

function mapDevice(row: {
  id: string | number
  device_id: string
  workspace_id: string
  user_id: string
  device_name: string
  status: string
  version: string | null
  last_heartbeat_at: Date | string | null
  last_observation_at: Date | string | null
  scanned_count: string | number
  success_count_today: string | number
  failure_count_today: string | number
  created_at: Date | string
}): DesktopAgentDeviceRow {
  return {
    id: Number(row.id),
    deviceId: row.device_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    deviceName: row.device_name,
    status: row.status as DesktopAgentDeviceStatus,
    version: row.version,
    lastHeartbeatAt: row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : null,
    lastObservationAt: row.last_observation_at ? new Date(row.last_observation_at) : null,
    scannedCount: Number(row.scanned_count) || 0,
    successCountToday: Number(row.success_count_today) || 0,
    failureCountToday: Number(row.failure_count_today) || 0,
    createdAt: new Date(row.created_at),
  }
}

export function isDeviceOnline(device: Pick<DesktopAgentDeviceRow, "status" | "lastHeartbeatAt">): boolean {
  if (device.status === "REVOKED") return false
  if (device.status !== "ONLINE" && device.status !== "OFFLINE") return false
  if (!device.lastHeartbeatAt) return false
  return Date.now() - device.lastHeartbeatAt.getTime() <= OFFLINE_AFTER_MS
}

export async function registerDesktopAgentDevice(input: {
  workspaceId: string
  userId: string
  deviceName?: string
  version?: string | null
}): Promise<{ device: DesktopAgentDeviceRow; plainToken: string }> {
  const deviceId = `da_${crypto.randomBytes(16).toString("hex")}`
  const { plainToken, tokenHash } = generateDesktopAgentToken()
  const name = (input.deviceName ?? "Desktop Agent").trim().slice(0, 120) || "Desktop Agent"
  const res = await query<{
    id: string
    device_id: string
    workspace_id: string
    user_id: string
    device_name: string
    status: string
    version: string | null
    last_heartbeat_at: Date | null
    last_observation_at: Date | null
    scanned_count: string
    success_count_today: string
    failure_count_today: string
    created_at: Date
  }>(
    `INSERT INTO desktop_agent_devices (
       device_id, workspace_id, user_id, device_name, token_hash, status, version,
       last_heartbeat_at, created_at, updated_at
     ) VALUES (
       $1, $2::uuid, $3::uuid, $4, $5, 'ONLINE', $6,
       NOW(), NOW(), NOW()
     )
     RETURNING id, device_id, workspace_id::text AS workspace_id, user_id::text AS user_id,
               device_name, status, version, last_heartbeat_at, last_observation_at,
               scanned_count::text, success_count_today::text, failure_count_today::text, created_at`,
    [deviceId, input.workspaceId, input.userId, name, tokenHash, input.version?.trim() || null]
  )
  return { device: mapDevice(res.rows[0]), plainToken }
}

export async function resolveDesktopAgentAuth(req: Request): Promise<DesktopAgentDeviceRow | null> {
  const raw = req.headers.authorization
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return null
  const plain = raw.slice(7).trim()
  if (!plain || plain.length < 20) return null
  const tokenHash = hashDesktopAgentToken(plain)
  const res = await query<{
    id: string
    device_id: string
    workspace_id: string
    user_id: string
    device_name: string
    status: string
    version: string | null
    last_heartbeat_at: Date | null
    last_observation_at: Date | null
    scanned_count: string
    success_count_today: string
    failure_count_today: string
    created_at: Date
  }>(
    `SELECT id, device_id, workspace_id::text AS workspace_id, user_id::text AS user_id,
            device_name, status, version, last_heartbeat_at, last_observation_at,
            scanned_count::text, success_count_today::text, failure_count_today::text, created_at
     FROM desktop_agent_devices
     WHERE token_hash = $1
     LIMIT 1`,
    [tokenHash]
  )
  const row = res.rows[0]
  if (!row || row.status === "REVOKED") return null
  return mapDevice(row)
}

export async function recordDesktopAgentHeartbeat(input: {
  deviceId: string
  workspaceId: string
  version?: string | null
  scannedCount?: number | null
  workerState?: string | null
  metrics?: Record<string, unknown> | null
}): Promise<DesktopAgentDeviceRow> {
  const metrics =
    input.metrics && typeof input.metrics === "object"
      ? {
          ...input.metrics,
          workerState: input.workerState ?? input.metrics.workerState ?? null,
        }
      : input.workerState
        ? { workerState: input.workerState }
        : null
  const scanned =
    typeof input.scannedCount === "number" && Number.isFinite(input.scannedCount) && input.scannedCount >= 0
      ? Math.floor(input.scannedCount)
      : null
  const res = await query<{
    id: string
    device_id: string
    workspace_id: string
    user_id: string
    device_name: string
    status: string
    version: string | null
    last_heartbeat_at: Date | null
    last_observation_at: Date | null
    scanned_count: string
    success_count_today: string
    failure_count_today: string
    created_at: Date
  }>(
    `UPDATE desktop_agent_devices
     SET status = 'ONLINE',
         last_heartbeat_at = NOW(),
         version = COALESCE($3, version),
         scanned_count = COALESCE($4, scanned_count),
         metrics_json = COALESCE($5::jsonb, metrics_json),
         updated_at = NOW()
     WHERE device_id = $1
       AND workspace_id = $2::uuid
       AND status <> 'REVOKED'
     RETURNING id, device_id, workspace_id::text AS workspace_id, user_id::text AS user_id,
               device_name, status, version, last_heartbeat_at, last_observation_at,
               scanned_count::text, success_count_today::text, failure_count_today::text, created_at`,
    [
      input.deviceId,
      input.workspaceId,
      input.version?.trim() || null,
      scanned,
      metrics ? JSON.stringify(metrics) : null,
    ]
  )
  const row = res.rows[0]
  if (!row) throw Object.assign(new Error("Device not found"), { status: 404 })
  return mapDevice(row)
}

export async function bumpDesktopAgentObservationStats(input: {
  deviceId: string
  workspaceId: string
  kind: "SUCCESS" | "TECHNICAL_FAILURE"
}): Promise<void> {
  if (input.kind === "SUCCESS") {
    await query(
      `UPDATE desktop_agent_devices
       SET last_observation_at = NOW(),
           success_day = CURRENT_DATE,
           success_count_today = CASE
             WHEN success_day = CURRENT_DATE THEN success_count_today + 1
             ELSE 1
           END,
           updated_at = NOW()
       WHERE device_id = $1 AND workspace_id = $2::uuid`,
      [input.deviceId, input.workspaceId]
    )
    return
  }
  await query(
    `UPDATE desktop_agent_devices
     SET failure_day = CURRENT_DATE,
         failure_count_today = CASE
           WHEN failure_day = CURRENT_DATE THEN failure_count_today + 1
           ELSE 1
         END,
         updated_at = NOW()
     WHERE device_id = $1 AND workspace_id = $2::uuid`,
    [input.deviceId, input.workspaceId]
  )
}

export async function listDesktopAgentDevicesForWorkspace(workspaceId: string): Promise<
  Array<
    DesktopAgentDeviceRow & {
      online: boolean
      metricsJson: Record<string, unknown> | null
    }
  >
> {
  const res = await query<{
    id: string
    device_id: string
    workspace_id: string
    user_id: string
    device_name: string
    status: string
    version: string | null
    last_heartbeat_at: Date | null
    last_observation_at: Date | null
    scanned_count: string
    success_count_today: string
    failure_count_today: string
    created_at: Date
    metrics_json: Record<string, unknown> | null
  }>(
    `SELECT id, device_id, workspace_id::text AS workspace_id, user_id::text AS user_id,
            device_name, status, version, last_heartbeat_at, last_observation_at,
            scanned_count::text, success_count_today::text, failure_count_today::text,
            created_at, metrics_json
     FROM desktop_agent_devices
     WHERE workspace_id = $1::uuid
       AND status <> 'REVOKED'
     ORDER BY last_heartbeat_at DESC NULLS LAST, id DESC`,
    [workspaceId]
  )
  return res.rows.map(row => {
    const device = mapDevice(row)
    return {
      ...device,
      online: isDeviceOnline(device),
      metricsJson: row.metrics_json && typeof row.metrics_json === "object" ? row.metrics_json : null,
    }
  })
}

/** Revoke device in caller's workspace only — rotates token_hash so Bearer stops working. */
export async function revokeDesktopAgentDevice(input: {
  workspaceId: string
  deviceId: string
}): Promise<{ ok: true; deviceId: string } | { ok: false; code: "NOT_FOUND" }> {
  const tombstone = `revoked_${crypto.randomBytes(24).toString("hex")}`
  const res = await query<{ device_id: string }>(
    `UPDATE desktop_agent_devices
     SET status = 'REVOKED',
         token_hash = $3,
         updated_at = NOW()
     WHERE device_id = $1
       AND workspace_id = $2::uuid
       AND status <> 'REVOKED'
     RETURNING device_id`,
    [input.deviceId, input.workspaceId, tombstone]
  )
  if (!res.rows[0]) return { ok: false, code: "NOT_FOUND" }
  return { ok: true, deviceId: res.rows[0].device_id }
}
