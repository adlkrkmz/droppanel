import { db, query } from "../../db/client"
import { loadAmazonVerificationConfig } from "../amazonVerification/amazonVerificationConfig"
import {
  enqueueVerificationTask,
  failVerificationTask,
  submitVerificationResult,
  type VerificationTaskRow,
} from "../amazonVerification/amazonVerificationQueue"
import type { VerificationReason, VerificationTaskStatus } from "../amazonVerification/amazonVerificationTypes"
import {
  ensureDesktopAgentGlobalAsin,
  findDesktopAgentListingForAsin,
} from "./desktopAgentAsins"
import type { DesktopAgentDeviceRow } from "./desktopAgentTypes"
import { isDesktopAgentAutomationEnabled } from "./desktopAgentAutomationGate"

type DesktopObservationFreshness = "NEW" | "DUPLICATE" | "STALE"

export type DesktopClaimResult =
  | { ok: true; task: VerificationTaskRow; created: boolean }
  | { ok: false; code: "TASK_BUSY" | "NO_LISTING" | "CLAIM_FAILED" | "DUPLICATE_OBSERVATION" | "STALE_OBSERVATION" | "DESKTOP_AGENT_DISABLED"; message: string }
  | { ok: false; code: "TASK_DEFERRED"; message: string; deferUntil: string }

async function inspectDesktopObservationFreshness(input: {
  workspaceId: string
  asin: string
  checkedAt: Date
  observationId?: string | null
  observationFingerprint?: string | null
}): Promise<{ status: DesktopObservationFreshness; lastCheckedAt: Date | null }> {
  const result = await query<{
    checked_at: string | null
    completed_at: string | null
    observation_id: string | null
    observation_fingerprint: string | null
  }>(
    `SELECT
       result_metadata->>'checkedAt' AS checked_at,
       completed_at::text AS completed_at,
       result_metadata->>'desktopObservationId' AS observation_id,
       result_metadata->>'desktopObservationFingerprint' AS observation_fingerprint
     FROM amazon_price_verification_tasks
     WHERE workspace_id = $1::uuid
       AND UPPER(asin) = $2
       AND reason = 'DESKTOP_AGENT'
       AND status = 'COMPLETED'
     ORDER BY completed_at DESC NULLS LAST
     LIMIT 100`,
    [input.workspaceId, input.asin.trim().toUpperCase()]
  )
  let lastCheckedAt: Date | null = null
  for (const row of result.rows) {
    if (
      input.observationId &&
      row.observation_id &&
      input.observationId === row.observation_id
    ) {
      return { status: "DUPLICATE", lastCheckedAt }
    }
    if (
      input.observationFingerprint &&
      row.observation_fingerprint &&
      input.observationFingerprint === row.observation_fingerprint
    ) {
      return { status: "DUPLICATE", lastCheckedAt }
    }
    const raw = row.checked_at ?? row.completed_at
    const at = raw ? new Date(raw) : null
    if (!at || Number.isNaN(at.getTime())) continue
    if (lastCheckedAt == null || at.getTime() > lastCheckedAt.getTime()) lastCheckedAt = at
  }
  if (lastCheckedAt && input.checkedAt.getTime() <= lastCheckedAt.getTime()) {
    return { status: "STALE", lastCheckedAt }
  }
  return { status: "NEW", lastCheckedAt }
}

async function findActiveTaskForAsin(input: {
  workspaceId: string
  asin: string
}): Promise<{
  id: number
  status: VerificationTaskStatus
  catalogStateId: number
  preferredUserId: string
} | null> {
  const res = await query<{
    id: string
    status: string
    catalog_state_id: string
    preferred_user_id: string
  }>(
    `SELECT id::text, status, catalog_state_id::text, preferred_user_id::text
     FROM amazon_price_verification_tasks
     WHERE workspace_id = $1::uuid
       AND UPPER(asin) = $2
       AND status IN ('PENDING','CLAIMED','RUNNING','WAITING_FOR_WORKER','RETRYABLE')
     ORDER BY
       CASE
         WHEN status IN ('CLAIMED','RUNNING') THEN 0
         ELSE 1
       END ASC,
       id DESC
     LIMIT 1`,
    [input.workspaceId, input.asin.trim().toUpperCase()]
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    id: Number(row.id),
    status: row.status as VerificationTaskStatus,
    catalogStateId: Number(row.catalog_state_id),
    preferredUserId: row.preferred_user_id,
  }
}

/**
 * Attach to an existing claimable verification task for the ASIN, or create a
 * minimal DESKTOP_AGENT task. Never steals a live SERVER_BROWSER / EXTENSION lease.
 */
export async function claimOrCreateDesktopVerificationTask(input: {
  device: DesktopAgentDeviceRow
  asin: string
  checkedAt?: Date
  observationId?: string | null
  observationFingerprint?: string | null
}): Promise<DesktopClaimResult> {
  if (!isDesktopAgentAutomationEnabled()) {
    return { ok: false, code: "DESKTOP_AGENT_DISABLED", message: "Desktop Agent assignments are disabled" }
  }

  const listing = await findDesktopAgentListingForAsin({
    workspaceId: input.device.workspaceId,
    asin: input.asin,
  })
  if (!listing) {
    return { ok: false, code: "NO_LISTING", message: "ASIN not in this workspace active set" }
  }

  if (input.checkedAt) {
    const freshness = await inspectDesktopObservationFreshness({
      workspaceId: input.device.workspaceId,
      asin: listing.asin,
      checkedAt: input.checkedAt,
      observationId: input.observationId,
      observationFingerprint: input.observationFingerprint,
    })
    if (freshness.status === "DUPLICATE") {
      return {
        ok: false,
        code: "DUPLICATE_OBSERVATION",
        message: "Desktop observation already accepted",
      }
    }
    if (freshness.status === "STALE") {
      return {
        ok: false,
        code: "STALE_OBSERVATION",
        message: "Desktop observation is older than the latest accepted observation",
      }
    }
  }

  const globalAsinId =
    listing.globalAsinId ??
    (await ensureDesktopAgentGlobalAsin(listing.asin, listing.priority))

  let existing = await findActiveTaskForAsin({
    workspaceId: input.device.workspaceId,
    asin: listing.asin,
  })

  let created = false
  if (!existing) {
    const enq = await enqueueVerificationTask({
      globalAsinId,
      workspaceId: input.device.workspaceId,
      preferredUserId: input.device.userId,
      catalogStateId: listing.catalogStateId,
      asin: listing.asin,
      reason: "DESKTOP_AGENT" as VerificationReason,
      priority: listing.priority,
      workerOnline: true,
    })
    created = enq.created
    existing = {
      id: enq.taskId,
      status: enq.status,
      catalogStateId: listing.catalogStateId,
      preferredUserId: input.device.userId,
    }
  }

  if (existing.status === "CLAIMED" || existing.status === "RUNNING") {
    const hold = await query<{
      worker_id: string | null
      claimed_by_source: string | null
      lease_expires_at: Date | null
    }>(
      `SELECT worker_id, claimed_by_source, lease_expires_at
       FROM amazon_price_verification_tasks WHERE id = $1::bigint`,
      [existing.id]
    )
    const h = hold.rows[0]
    const leaseOk =
      h?.lease_expires_at != null && new Date(h.lease_expires_at).getTime() > Date.now()
    const workerId = desktopWorkerId(input.device.deviceId)
    if (leaseOk && h?.worker_id && h.worker_id !== workerId) {
      return {
        ok: false,
        code: "TASK_BUSY",
        message: `Task held by ${h.claimed_by_source ?? "OTHER"}`,
      }
    }
  }

  const cfg = loadAmazonVerificationConfig()
  const workerId = desktopWorkerId(input.device.deviceId)
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const claimed = await client.query<{
      id: string
      global_asin_id: string
      workspace_id: string
      preferred_user_id: string
      catalog_state_id: string
      asin: string
      amazon_url: string
      reason: string
      status: string
      attempt_count: string
      lease_expires_at: Date | null
    }>(
      `UPDATE amazon_price_verification_tasks t
       SET status = 'CLAIMED',
           worker_id = $3::text,
           claimed_by_source = 'DESKTOP_AGENT',
           preferred_user_id = $2::uuid,
           claimed_at = NOW(),
           started_at = COALESCE(t.started_at, NOW()),
           lease_expires_at = NOW() + make_interval(secs => $4::int),
           updated_at = NOW()
       WHERE t.id = $1::bigint
         AND t.workspace_id = $5::uuid
         AND t.available_at <= NOW()
         AND (
           t.status IN ('PENDING','RETRYABLE','WAITING_FOR_WORKER')
           OR (
             t.status IN ('CLAIMED','RUNNING')
             AND (t.lease_expires_at IS NULL OR t.lease_expires_at < NOW())
           )
           OR (
             t.status IN ('CLAIMED','RUNNING')
             AND t.worker_id = $3::text
           )
         )
         AND NOT (
           t.status IN ('CLAIMED','RUNNING')
           AND t.lease_expires_at IS NOT NULL
           AND t.lease_expires_at > NOW()
           AND t.worker_id IS DISTINCT FROM $3::text
         )
       RETURNING t.id::text, t.global_asin_id::text, t.workspace_id::text AS workspace_id,
                 t.preferred_user_id::text AS preferred_user_id, t.catalog_state_id::text,
                 t.asin, t.amazon_url, t.reason, t.status, t.attempt_count::text,
                 t.lease_expires_at`,
      [existing.id, input.device.userId, workerId, cfg.leaseSeconds, input.device.workspaceId]
    )
    const row = claimed.rows[0]
    if (!row) {
      await client.query("ROLLBACK")
      const current = await query<{
        status: string
        available_at: Date | null
        available_at_future: boolean
        lease_expires_at: Date | null
        worker_id: string | null
      }>(
        `SELECT status, available_at, available_at > NOW() AS available_at_future,
                lease_expires_at, worker_id
         FROM amazon_price_verification_tasks
         WHERE id = $1::bigint
           AND workspace_id = $2::uuid`,
        [existing.id, input.device.workspaceId]
      )
      const currentTask = current.rows[0]
      const isActiveTask =
        currentTask != null &&
        ["PENDING", "CLAIMED", "RUNNING", "WAITING_FOR_WORKER", "RETRYABLE"].includes(
          currentTask.status
        )
      const hasLiveForeignLease =
        isActiveTask &&
        (currentTask.status === "CLAIMED" || currentTask.status === "RUNNING") &&
        currentTask.lease_expires_at != null &&
        new Date(currentTask.lease_expires_at).getTime() > Date.now() &&
        currentTask.worker_id !== workerId
      if (
        isActiveTask &&
        currentTask?.available_at_future === true &&
        currentTask.available_at != null &&
        !hasLiveForeignLease
      ) {
        return {
          ok: false,
          code: "TASK_DEFERRED",
          message: "Verification task deferred",
          deferUntil: new Date(currentTask.available_at).toISOString(),
        }
      }
      return { ok: false, code: "CLAIM_FAILED", message: "Could not claim verification task" }
    }
    await client.query("COMMIT")
    return {
      ok: true,
      created,
      task: {
        id: Number(row.id),
        globalAsinId: Number(row.global_asin_id),
        workspaceId: row.workspace_id,
        preferredUserId: row.preferred_user_id,
        catalogStateId: Number(row.catalog_state_id),
        asin: row.asin,
        amazonUrl: row.amazon_url,
        reason: row.reason as VerificationReason,
        status: "CLAIMED",
        attemptCount: Number(row.attempt_count) || 0,
        leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
      },
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

export function desktopWorkerId(deviceId: string): string {
  return `desktop-agent:${deviceId}`
}

export async function submitDesktopVerificationResult(input: {
  device: DesktopAgentDeviceRow
  task: VerificationTaskRow
  payload: Parameters<typeof submitVerificationResult>[0]["payload"]
}): Promise<Awaited<ReturnType<typeof submitVerificationResult>>> {
  return submitVerificationResult({
    taskId: input.task.id,
    workspaceId: input.device.workspaceId,
    userId: input.device.userId,
    workerId: desktopWorkerId(input.device.deviceId),
    payload: input.payload,
    confirmationSource: "DESKTOP_AGENT",
  })
}

export async function failDesktopVerificationTask(input: {
  device: DesktopAgentDeviceRow
  task: VerificationTaskRow
  code: string
  message: string
}): Promise<Awaited<ReturnType<typeof failVerificationTask>>> {
  return failVerificationTask({
    taskId: input.task.id,
    workspaceId: input.device.workspaceId,
    userId: input.device.userId,
    workerId: desktopWorkerId(input.device.deviceId),
    code: input.code,
    message: input.message,
  })
}

export async function logDesktopObservationEvent(input: {
  device: DesktopAgentDeviceRow
  asin: string
  catalogStateId?: number | null
  taskId?: number | null
  eventKind: "SUCCESS" | "TECHNICAL_FAILURE" | "REJECTED"
  publicStatus?: string | null
  decisionCode?: string | null
  errorCode?: string | null
}): Promise<void> {
  await query(
    `INSERT INTO desktop_agent_observation_events (
       workspace_id, user_id, device_id, asin, catalog_state_id, task_id,
       event_kind, public_status, decision_code, error_code, created_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5::bigint, $6::bigint,
       $7, $8, $9, $10, NOW()
     )`,
    [
      input.device.workspaceId,
      input.device.userId,
      input.device.deviceId,
      input.asin.trim().toUpperCase(),
      input.catalogStateId ?? null,
      input.taskId ?? null,
      input.eventKind,
      input.publicStatus ?? null,
      input.decisionCode ?? null,
      input.errorCode ?? null,
    ]
  ).catch(() => undefined)
}
