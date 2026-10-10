import { query } from "../../db/client"
import { loadAmazonVerificationConfig } from "../amazonVerification/amazonVerificationConfig"
import { workerIsOnline } from "../amazonVerification/amazonVerificationPolicy"
import { AMAZON_BROWSER_WORKER_ID } from "./amazonBrowserWorkerConstants"

export type AmazonBrowserHeartbeatRow = {
  workerId: string
  status: string
  lastHeartbeatAt: Date | null
  browserRunning: boolean
  amazonSessionState: string
  currentTaskId: number | null
  queuePending: number | null
  lastSuccessAt: Date | null
  lastError: string | null
  pauseReason: string | null
}

function mapRow(row: Record<string, unknown>): AmazonBrowserHeartbeatRow {
  return {
    workerId: String(row.worker_id),
    status: String(row.status ?? "OFFLINE"),
    lastHeartbeatAt: row.last_heartbeat_at ? new Date(String(row.last_heartbeat_at)) : null,
    browserRunning: row.browser_running === true,
    amazonSessionState: String(row.amazon_session_state ?? "UNKNOWN"),
    currentTaskId: row.current_task_id != null ? Number(row.current_task_id) : null,
    queuePending: row.queue_pending != null ? Number(row.queue_pending) : null,
    lastSuccessAt: row.last_success_at ? new Date(String(row.last_success_at)) : null,
    lastError: typeof row.last_error === "string" ? row.last_error : null,
    pauseReason: typeof row.pause_reason === "string" ? row.pause_reason : null,
  }
}

export async function upsertAmazonBrowserHeartbeat(input: {
  status: string
  browserRunning: boolean
  amazonSessionState: string
  currentTaskId?: number | null
  queuePending?: number | null
  lastSuccessAt?: Date | null
  lastError?: string | null
  pauseReason?: string | null
  /** Defaults to legacy login worker id. Public worker must pass its own id. */
  workerId?: string
}): Promise<void> {
  const workerId = input.workerId?.trim() || AMAZON_BROWSER_WORKER_ID
  await query(
    `INSERT INTO amazon_browser_worker_heartbeat (
       worker_id, status, last_heartbeat_at, browser_running, amazon_session_state,
       current_task_id, queue_pending, last_success_at, last_error, pause_reason, updated_at
     ) VALUES (
       $1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, NOW()
     )
     ON CONFLICT (worker_id) DO UPDATE SET
       status = EXCLUDED.status,
       last_heartbeat_at = NOW(),
       browser_running = EXCLUDED.browser_running,
       amazon_session_state = EXCLUDED.amazon_session_state,
       current_task_id = EXCLUDED.current_task_id,
       queue_pending = COALESCE(EXCLUDED.queue_pending, amazon_browser_worker_heartbeat.queue_pending),
       last_success_at = COALESCE(EXCLUDED.last_success_at, amazon_browser_worker_heartbeat.last_success_at),
       last_error = EXCLUDED.last_error,
       pause_reason = EXCLUDED.pause_reason,
       updated_at = NOW()`,
    [
      workerId,
      input.status,
      input.browserRunning,
      input.amazonSessionState,
      input.currentTaskId ?? null,
      input.queuePending ?? null,
      input.lastSuccessAt ?? null,
      input.lastError ?? null,
      input.pauseReason ?? null,
    ]
  )
}

export async function getAmazonBrowserHeartbeat(
  workerId: string = AMAZON_BROWSER_WORKER_ID
): Promise<AmazonBrowserHeartbeatRow | null> {
  const res = await query(`SELECT * FROM amazon_browser_worker_heartbeat WHERE worker_id = $1`, [workerId])
  if (!res.rows[0]) return null
  return mapRow(res.rows[0] as Record<string, unknown>)
}

export async function isAmazonBrowserWorkerAccepting(): Promise<boolean> {
  const cfg = loadAmazonVerificationConfig()
  if (!cfg.serverBrowserEnabled) return false
  const hb = await getAmazonBrowserHeartbeat()
  if (!hb) return cfg.serverBrowserPrimary
  if (["PAUSED", "CHALLENGE_REQUIRED", "LOGIN_REQUIRED", "ERROR", "OFFLINE"].includes(hb.status)) {
    return false
  }
  return workerIsOnline({
    lastHeartbeatAt: hb.lastHeartbeatAt,
    now: new Date(),
    offlineAfterSeconds: cfg.workerOfflineAfterSeconds,
  })
}

export function amazonBrowserWorkerOnline(hb: AmazonBrowserHeartbeatRow | null): boolean {
  const cfg = loadAmazonVerificationConfig()
  if (!hb) return false
  return workerIsOnline({
    lastHeartbeatAt: hb.lastHeartbeatAt,
    now: new Date(),
    offlineAfterSeconds: cfg.workerOfflineAfterSeconds,
  })
}
