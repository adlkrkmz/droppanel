import { query } from "../../db/client"
import { loadAmazonVerificationConfig } from "./amazonVerificationConfig"
import { workerIsOnline } from "./amazonVerificationPolicy"

export type ExtensionWorkerRow = {
  id: number
  workerId: string
  userId: string
  workspaceId: string
  deviceId: string
  amazonAvailable: boolean | null
  lastHeartbeatAt: Date
  status: string
  activeTaskCount: number
  currentTaskId: number | null
}

export async function upsertExtensionHeartbeat(input: {
  userId: string
  workspaceId: string
  deviceId: string
  extensionVersion?: string | null
  amazonAvailable?: boolean | null
  activeTaskId?: number | null
}): Promise<ExtensionWorkerRow> {
  const deviceId = input.deviceId.trim()
  if (!deviceId || deviceId.length > 80) throw new Error("deviceId is required")
  const workerId = `ext-${input.workspaceId.slice(0, 8)}-${input.userId.slice(0, 8)}-${deviceId}`
  const res = await query<{
    id: number
    worker_id: string
    user_id: string
    workspace_id: string
    device_id: string
    amazon_available: boolean | null
    last_heartbeat_at: Date
    status: string
    active_task_count: string
    current_task_id: number | null
  }>(
    `INSERT INTO extension_workers (
       worker_id, user_id, workspace_id, device_id, extension_version,
       last_heartbeat_at, last_seen_at, status, amazon_available,
       current_task_id, updated_at
     ) VALUES (
       $1, $2::uuid, $3::uuid, $4, $5,
       NOW(), NOW(), 'ONLINE', $6,
       $7::bigint, NOW()
     )
     ON CONFLICT (workspace_id, user_id, device_id) DO UPDATE SET
       worker_id = EXCLUDED.worker_id,
       extension_version = COALESCE(EXCLUDED.extension_version, extension_workers.extension_version),
       last_heartbeat_at = NOW(),
       last_seen_at = NOW(),
       status = 'ONLINE',
       amazon_available = COALESCE(EXCLUDED.amazon_available, extension_workers.amazon_available),
       current_task_id = COALESCE(EXCLUDED.current_task_id, extension_workers.current_task_id),
       updated_at = NOW()
     RETURNING id, worker_id, user_id::text AS user_id, workspace_id::text AS workspace_id,
               device_id, amazon_available, last_heartbeat_at, status,
               active_task_count::text, current_task_id`,
    [
      workerId.slice(0, 120),
      input.userId,
      input.workspaceId,
      deviceId,
      input.extensionVersion ?? null,
      input.amazonAvailable ?? null,
      input.activeTaskId ?? null,
    ]
  )
  const row = res.rows[0]
  await query(
    `UPDATE amazon_price_verification_tasks t
     SET preferred_user_id = $2::uuid,
         status = CASE WHEN t.status = 'WAITING_FOR_WORKER' THEN 'PENDING' ELSE t.status END,
         updated_at = NOW()
     WHERE t.workspace_id = $1::uuid
       AND t.status IN ('PENDING', 'RETRYABLE', 'WAITING_FOR_WORKER')
       AND EXISTS (
         SELECT 1 FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id AND u.approval_status = 'active'
         WHERE wm.workspace_id = t.workspace_id AND wm.user_id = $2::uuid
       )`,
    [input.workspaceId, input.userId]
  )
  return {
    id: Number(row.id),
    workerId: row.worker_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    deviceId: row.device_id,
    amazonAvailable: row.amazon_available,
    lastHeartbeatAt: new Date(row.last_heartbeat_at),
    status: row.status,
    activeTaskCount: parseInt(row.active_task_count ?? "0", 10) || 0,
    currentTaskId: row.current_task_id != null ? Number(row.current_task_id) : null,
  }
}

export async function markWorkerCaptcha(workerId: string): Promise<void> {
  await query(
    `UPDATE extension_workers
     SET amazon_available = false,
         status = 'AMAZON_BLOCKED',
         recent_captcha_count = recent_captcha_count + 1,
         updated_at = NOW()
     WHERE worker_id = $1`,
    [workerId]
  )
}

export async function markWorkerVerificationSuccess(workerId: string): Promise<void> {
  await query(
    `UPDATE extension_workers
     SET last_successful_verification_at = NOW(),
         recent_failure_count = 0,
         amazon_available = true,
         status = 'ONLINE',
         active_task_count = GREATEST(active_task_count - 1, 0),
         current_task_id = NULL,
         updated_at = NOW()
     WHERE worker_id = $1`,
    [workerId]
  )
}

export async function countOnlineWorkers(workspaceId?: string): Promise<number> {
  const cfg = loadAmazonVerificationConfig()
  const res = workspaceId
    ? await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM extension_workers
         WHERE workspace_id = $1::uuid
           AND last_heartbeat_at >= NOW() - make_interval(secs => $2::int)`,
        [workspaceId, cfg.workerOfflineAfterSeconds]
      )
    : await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM extension_workers
         WHERE last_heartbeat_at >= NOW() - make_interval(secs => $1::int)`,
        [cfg.workerOfflineAfterSeconds]
      )
  return parseInt(res.rows[0]?.c ?? "0", 10) || 0
}

export function mapWorkerOnline(lastHeartbeatAt: Date, now = new Date()): boolean {
  return workerIsOnline({
    lastHeartbeatAt,
    now,
    offlineAfterSeconds: loadAmazonVerificationConfig().workerOfflineAfterSeconds,
  })
}
