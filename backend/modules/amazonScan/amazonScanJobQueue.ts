import crypto from "crypto"
import type { PoolClient } from "pg"
import { db, query } from "../../db/client"
import { nextVerificationRetryAt } from "../amazonVerification/amazonVerificationPolicy"
import { KEEPA_VERIFY_PRIMARY_ACTIVE_CAP } from "../keepaSensor/keepaVerifyChainPolicy"
import { loadAmazonScanConfig } from "./amazonScanConfig"
import { buildAmazonScanKey } from "./amazonScanKey"
import { resolveScanClaimKind } from "./amazonScanApplyPolicy"

export type ScanJobKind =
  | "ROUTINE"
  | "CONFIRM"
  | "KEEPA_VERIFY_PRIMARY"
  | "KEEPA_VERIFY_CONFIRM"
  | "OXYLABS_PRODUCT_PRIMARY"
  | "OXYLABS_PRODUCT_CONFIRM"

export type AmazonScanJobRow = {
  id: number
  scanKey: string
  globalAsinId: number
  asin: string
  marketplace: string
  deliveryZip: string
  sessionClass: string
  kind: ScanJobKind
  priority: number
  status: string
  workerId: string | null
  leaseToken: string | null
  leaseExpiresAt: Date | null
  attemptCount: number
  parentJobId: number | null
  requireFreshNav: boolean
  keepaCandidateId: number | null
}

function mapJob(row: Record<string, unknown>): AmazonScanJobRow {
  return {
    id: Number(row.id),
    scanKey: String(row.scan_key),
    globalAsinId: Number(row.global_asin_id),
    asin: String(row.asin),
    marketplace: String(row.marketplace),
    deliveryZip: String(row.delivery_zip),
    sessionClass: String(row.session_class),
    kind: ([
      "ROUTINE",
      "CONFIRM",
      "KEEPA_VERIFY_PRIMARY",
      "KEEPA_VERIFY_CONFIRM",
      "OXYLABS_PRODUCT_PRIMARY",
      "OXYLABS_PRODUCT_CONFIRM",
    ].includes(String(row.kind))
      ? (row.kind as ScanJobKind)
      : "ROUTINE"),
    priority: Number(row.priority) || 2,
    status: String(row.status),
    workerId: row.worker_id != null ? String(row.worker_id) : null,
    leaseToken: row.lease_token != null ? String(row.lease_token) : null,
    leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)) : null,
    attemptCount: Number(row.attempt_count) || 0,
    parentJobId: row.parent_job_id != null ? Number(row.parent_job_id) : null,
    requireFreshNav: row.require_fresh_nav === true,
    keepaCandidateId: row.keepa_candidate_id != null ? Number(row.keepa_candidate_id) : null,
  }
}

export async function countActiveScanJobs(kind?: ScanJobKind): Promise<number> {
  const res = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM amazon_scan_jobs
     WHERE status IN ('PENDING','CLAIMED','RUNNING','WAITING_FOR_WORKER','RETRYABLE')
       AND ($1::text IS NULL OR kind = $1::text)`,
    [kind ?? null]
  )
  return parseInt(res.rows[0]?.c ?? "0", 10) || 0
}

export async function enqueueScanJob(input: {
  globalAsinId: number
  asin: string
  marketplace: string
  deliveryZip: string
  sessionClass: string
  kind: ScanJobKind
  priority?: number
  parentJobId?: number | null
  requireFreshNav?: boolean
  availableAt?: Date
  keepaCandidateId?: number | null
}): Promise<{ jobId: number; created: boolean }> {
  const cfg = loadAmazonScanConfig()
  const scanKey = buildAmazonScanKey(input)
  const existing = await query<{ id: number }>(
    `SELECT id FROM amazon_scan_jobs
     WHERE scan_key = $1 AND kind = $2
       AND status IN ('PENDING','CLAIMED','RUNNING','WAITING_FOR_WORKER','RETRYABLE')
     LIMIT 1`,
    [scanKey, input.kind]
  )
  if (existing.rows[0]) return { jobId: Number(existing.rows[0].id), created: false }

  const cap =
    input.kind === "KEEPA_VERIFY_PRIMARY"
      ? cfg.keepaVerifyPrimaryMaxActive || KEEPA_VERIFY_PRIMARY_ACTIVE_CAP
      : input.kind === "CONFIRM" || input.kind === "KEEPA_VERIFY_CONFIRM"
        ? cfg.maxPendingConfirm
        : cfg.maxPendingRoutine
  const pending = await countActiveScanJobs(input.kind)
  if (pending >= cap) return { jobId: 0, created: false }

  try {
    const res = await query<{ id: number }>(
      `INSERT INTO amazon_scan_jobs (
         scan_key, global_asin_id, asin, marketplace, delivery_zip, session_class,
         kind, priority, status, available_at, parent_job_id, require_fresh_nav, keepa_candidate_id, created_at, updated_at
       ) VALUES (
         $1,$2::bigint,$3,$4,$5,$6,$7,$8,'PENDING',COALESCE($9::timestamptz, NOW()),$10::bigint,$11,$12::bigint,NOW(),NOW()
       )
       RETURNING id`,
      [
        scanKey,
        input.globalAsinId,
        input.asin.trim().toUpperCase(),
        input.marketplace,
        input.deliveryZip,
        input.sessionClass,
        input.kind,
        input.priority ?? (input.kind === "CONFIRM" || input.kind.startsWith("KEEPA_VERIFY") ? 0 : 2),
        input.availableAt ?? null,
        input.parentJobId ?? null,
        input.requireFreshNav === true,
        input.keepaCandidateId ?? null,
      ]
    )
    return { jobId: Number(res.rows[0].id), created: true }
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : ""
    if (code === "23505") {
      const again = await query<{ id: number }>(
        `SELECT id FROM amazon_scan_jobs
         WHERE scan_key = $1 AND kind = $2
           AND status IN ('PENDING','CLAIMED','RUNNING','WAITING_FOR_WORKER','RETRYABLE')
         LIMIT 1`,
        [scanKey, input.kind]
      )
      if (again.rows[0]) return { jobId: Number(again.rows[0].id), created: false }
    }
    throw e
  }
}

export async function claimNextScanJob(input: {
  workerId: string
  preferConfirm: boolean
}): Promise<AmazonScanJobRow | null> {
  const cfg = loadAmazonScanConfig()
  if (!cfg.remoteProtocolEnabled) {
    return null
  }
  const claimKind = resolveScanClaimKind(input.workerId)
  if (!claimKind) {
    return null
  }
  const verifyClaim = claimKind === "KEEPA_VERIFY_PRIMARY" || claimKind === "KEEPA_VERIFY_CONFIRM"
  if (verifyClaim) {
    if (!cfg.keepaVerifyClaimEnabled) return null
  } else if (!cfg.remoteWorkersEnabled) {
    return null
  }
  const leaseToken = crypto.randomBytes(24).toString("hex")
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const busy = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM amazon_scan_jobs
       WHERE worker_id = $1 AND status IN ('CLAIMED','RUNNING')`,
      [input.workerId]
    )
    if ((parseInt(busy.rows[0]?.c ?? "0", 10) || 0) >= 1) {
      await client.query("COMMIT")
      return null
    }
    const claimed = await client.query(
      `WITH candidate AS (
         SELECT t.id
         FROM amazon_scan_jobs t
         WHERE t.status IN ('PENDING','RETRYABLE','WAITING_FOR_WORKER')
           AND t.available_at <= NOW()
           AND (t.lease_expires_at IS NULL OR t.lease_expires_at < NOW())
           AND t.kind = $5::text
           AND t.kind NOT IN ('OXYLABS_PRODUCT_PRIMARY','OXYLABS_PRODUCT_CONFIRM')
         ORDER BY
           CASE WHEN $3::boolean AND t.kind = 'CONFIRM' THEN 0 ELSE 1 END,
           t.priority ASC, t.available_at ASC, t.id ASC
         LIMIT 1
         FOR UPDATE OF t SKIP LOCKED
       )
       UPDATE amazon_scan_jobs t
       SET status = 'CLAIMED',
           worker_id = $1,
           lease_token = $2,
           claimed_at = NOW(),
           started_at = COALESCE(t.started_at, NOW()),
           lease_expires_at = NOW() + make_interval(secs => $4::int),
           updated_at = NOW()
       FROM candidate
       WHERE t.id = candidate.id
         AND t.kind = $5::text
       RETURNING t.*`,
      [input.workerId, leaseToken, input.preferConfirm, cfg.leaseSeconds, claimKind]
    )
    await client.query("COMMIT")
    const row = claimed.rows[0]
    return row ? mapJob(row as Record<string, unknown>) : null
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

export async function markScanJobRunning(input: {
  jobId: number
  workerId: string
  leaseToken: string
}): Promise<boolean> {
  const res = await query(
    `UPDATE amazon_scan_jobs
     SET status = 'RUNNING', updated_at = NOW()
     WHERE id = $1::bigint AND worker_id = $2 AND lease_token = $3
       AND status IN ('CLAIMED','RUNNING')`,
    [input.jobId, input.workerId, input.leaseToken]
  )
  return (res.rowCount ?? 0) > 0
}

export async function renewScanJobLease(input: {
  jobId: number
  workerId: string
  leaseToken: string
}): Promise<boolean> {
  const cfg = loadAmazonScanConfig()
  const res = await query(
    `UPDATE amazon_scan_jobs
     SET lease_expires_at = NOW() + make_interval(secs => $4::int), updated_at = NOW()
     WHERE id = $1::bigint AND worker_id = $2 AND lease_token = $3
       AND status IN ('CLAIMED','RUNNING')`,
    [input.jobId, input.workerId, input.leaseToken, cfg.leaseSeconds]
  )
  return (res.rowCount ?? 0) > 0
}

export async function completeScanJob(input: {
  jobId: number
  workerId: string
  leaseToken: string
  payload: Record<string, unknown>
  observedAt: Date
}): Promise<{ ok: true; alreadyCompleted?: boolean } | { ok: false; code: string }> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const existing = await client.query<{
      status: string
      worker_id: string | null
      lease_token: string | null
      lease_expires_at: Date | null
    }>(
      `SELECT status, worker_id, lease_token, lease_expires_at
       FROM amazon_scan_jobs WHERE id = $1::bigint
       FOR UPDATE`,
      [input.jobId]
    )
    const row = existing.rows[0]
    if (!row) {
      await client.query("ROLLBACK")
      return { ok: false, code: "NOT_FOUND" }
    }
    const insertOutbox = async (): Promise<void> => {
      await client.query(
        `INSERT INTO amazon_scan_apply_outbox (job_id, status, payload, available_at, created_at, updated_at)
         VALUES ($1::bigint, 'PENDING', $2::jsonb, NOW(), NOW(), NOW())
         ON CONFLICT (job_id) DO NOTHING`,
        [input.jobId, JSON.stringify({ ...input.payload, observedAt: input.observedAt.toISOString() })]
      )
    }
    if (row.status === "COMPLETED") {
      await insertOutbox()
      await client.query("COMMIT")
      await maybeEnqueueKeepaVerifyConfirm(input.jobId, input.payload)
      return { ok: true, alreadyCompleted: true }
    }
    if (row.worker_id !== input.workerId || row.lease_token !== input.leaseToken) {
      await client.query("ROLLBACK")
      return { ok: false, code: "STALE_LEASE" }
    }
    if (row.lease_expires_at && new Date(row.lease_expires_at).getTime() < Date.now()) {
      await client.query("ROLLBACK")
      return { ok: false, code: "STALE_LEASE" }
    }
    if (row.status !== "CLAIMED" && row.status !== "RUNNING") {
      await client.query("ROLLBACK")
      return { ok: false, code: "WRONG_STATUS" }
    }
    const upd = await client.query(
      `UPDATE amazon_scan_jobs
       SET status = 'COMPLETED',
           completed_at = NOW(),
           observed_at = $2::timestamptz,
           result_payload = $3::jsonb,
           lease_expires_at = NULL,
           failure_code = NULL,
           failure_message = NULL,
           updated_at = NOW()
       WHERE id = $1::bigint AND worker_id = $4 AND lease_token = $5
         AND status IN ('CLAIMED','RUNNING')
       RETURNING id`,
      [input.jobId, input.observedAt, JSON.stringify(input.payload), input.workerId, input.leaseToken]
    )
    if (!upd.rowCount) {
      await client.query("ROLLBACK")
      return { ok: false, code: "WRONG_STATUS" }
    }
    await insertOutbox()
    await client.query("COMMIT")
    await maybeEnqueueKeepaVerifyConfirm(input.jobId, input.payload)
    return { ok: true }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

export async function maybeEnqueueKeepaVerifyConfirm(jobId: number, payload: Record<string, unknown>): Promise<void> {
  const job = await getScanJob(jobId)
  if (!job || job.kind !== "KEEPA_VERIFY_PRIMARY") return
  const { enqueueKeepaVerifyConfirmFromPrimary } = await import("../keepaSensor/keepaVerifyChain")
  await enqueueKeepaVerifyConfirmFromPrimary({
    parentJobId: job.id,
    globalAsinId: job.globalAsinId,
    asin: job.asin,
    marketplace: job.marketplace,
    deliveryZip: job.deliveryZip,
    sessionClass: job.sessionClass,
    keepaCandidateId: job.keepaCandidateId,
    payload,
  })
}

export async function failScanJob(input: {
  jobId: number
  workerId: string
  leaseToken: string
  code: string
  message: string
}): Promise<{ status: string }> {
  const cfg = loadAmazonScanConfig()
  const row = await query<{ attempt_count: number; status: string; worker_id: string | null; lease_token: string | null }>(
    `SELECT attempt_count, status, worker_id, lease_token FROM amazon_scan_jobs WHERE id = $1::bigint`,
    [input.jobId]
  )
  const task = row.rows[0]
  if (!task) return { status: "MISSING" }
  if (task.status === "COMPLETED") return { status: "COMPLETED" }
  if (task.worker_id !== input.workerId || task.lease_token !== input.leaseToken) {
    return { status: "STALE_LEASE" }
  }
  if (input.code === "CAPTCHA" || input.code === "CHALLENGE_REQUIRED") {
    await query(
      `UPDATE amazon_scan_jobs
       SET status = 'WAITING_FOR_WORKER',
           worker_id = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           failure_code = $2,
           failure_message = $3,
           available_at = NOW() + interval '30 minutes',
           updated_at = NOW()
       WHERE id = $1::bigint`,
      [input.jobId, input.code.slice(0, 80), input.message.slice(0, 400)]
    )
    return { status: "WAITING_FOR_WORKER" }
  }
  const attempt = (task.attempt_count || 0) + 1
  const terminal = attempt >= cfg.maxAttempts
  const next = nextVerificationRetryAt({ now: new Date(), attemptCount: attempt })
  await query(
    `UPDATE amazon_scan_jobs
     SET status = $2,
         attempt_count = $3,
         worker_id = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         failure_code = $4,
         failure_message = $5,
         available_at = $6::timestamptz,
         updated_at = NOW()
     WHERE id = $1::bigint`,
    [
      input.jobId,
      terminal ? "FAILED" : "RETRYABLE",
      attempt,
      terminal ? "MAX_ATTEMPTS_EXCEEDED" : input.code.slice(0, 80),
      input.message.slice(0, 400),
      terminal ? new Date() : next,
    ]
  )
  return { status: terminal ? "FAILED" : "RETRYABLE" }
}

export async function getScanJob(jobId: number): Promise<AmazonScanJobRow | null> {
  const res = await query(`SELECT * FROM amazon_scan_jobs WHERE id = $1::bigint`, [jobId])
  return res.rows[0] ? mapJob(res.rows[0] as Record<string, unknown>) : null
}

export async function enqueueApplyOutbox(jobId: number, payload: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO amazon_scan_apply_outbox (job_id, status, payload, available_at, created_at, updated_at)
     VALUES ($1::bigint, 'PENDING', $2::jsonb, NOW(), NOW(), NOW())
     ON CONFLICT (job_id) DO NOTHING`,
    [jobId, JSON.stringify(payload)]
  )
}

export async function claimApplyOutboxRows(limit: number): Promise<Array<{ id: number; jobId: number; payload: Record<string, unknown> }>> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const res = await client.query(
      `WITH picked AS (
         SELECT id FROM amazon_scan_apply_outbox
         WHERE status = 'PENDING' AND available_at <= NOW()
           AND (locked_until IS NULL OR locked_until < NOW())
           AND NOT EXISTS (
             SELECT 1 FROM amazon_scan_jobs j
             WHERE j.id = amazon_scan_apply_outbox.job_id
               AND j.kind IN ('OXYLABS_PRODUCT_PRIMARY','OXYLABS_PRODUCT_CONFIRM')
           )
         ORDER BY id ASC
         LIMIT $1::int
         FOR UPDATE SKIP LOCKED
       )
       UPDATE amazon_scan_apply_outbox o
       SET locked_until = NOW() + interval '2 minutes', updated_at = NOW()
       FROM picked
       WHERE o.id = picked.id
       RETURNING o.id, o.job_id, o.payload`,
      [Math.max(1, Math.min(10, limit))]
    )
    await client.query("COMMIT")
    return res.rows.map(r => ({
      id: Number(r.id),
      jobId: Number(r.job_id),
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }))
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

export async function markApplyOutboxDone(id: number): Promise<void> {
  await query(
    `UPDATE amazon_scan_apply_outbox SET status = 'DONE', locked_until = NULL, updated_at = NOW() WHERE id = $1::bigint`,
    [id]
  )
}

export async function markApplyOutboxRetry(id: number, error: string): Promise<void> {
  await query(
    `UPDATE amazon_scan_apply_outbox
     SET attempt_count = attempt_count + 1,
         available_at = NOW() + interval '1 minute',
         locked_until = NULL,
         last_error = $2,
         status = CASE WHEN attempt_count + 1 >= 8 THEN 'FAILED' ELSE 'PENDING' END,
         updated_at = NOW()
     WHERE id = $1::bigint`,
    [id, error.slice(0, 400)]
  )
}

export async function upsertScanHeartbeat(input: {
  workerId: string
  status: string
  browserRunning: boolean
  currentJobId?: number | null
  lastError?: string | null
  pauseReason?: string | null
  hostTelemetry?: Record<string, unknown> | null
}): Promise<void> {
  await query(
    `INSERT INTO amazon_scan_worker_heartbeat (
       worker_id, status, last_heartbeat_at, browser_running, current_job_id, last_error, pause_reason, host_telemetry, updated_at
     ) VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7::jsonb,NOW())
     ON CONFLICT (worker_id) DO UPDATE SET
       status = EXCLUDED.status,
       last_heartbeat_at = NOW(),
       browser_running = EXCLUDED.browser_running,
       current_job_id = EXCLUDED.current_job_id,
       last_error = EXCLUDED.last_error,
       pause_reason = EXCLUDED.pause_reason,
       host_telemetry = COALESCE(EXCLUDED.host_telemetry, amazon_scan_worker_heartbeat.host_telemetry),
       updated_at = NOW()`,
    [
      input.workerId,
      input.status,
      input.browserRunning,
      input.currentJobId ?? null,
      input.lastError ?? null,
      input.pauseReason ?? null,
      input.hostTelemetry ? JSON.stringify(input.hostTelemetry) : null,
    ]
  )
}

export async function recoverExpiredRunningScanJobs(limit = 20): Promise<number> {
  const rows = await query<{ id: number; worker_id: string; lease_token: string }>(
    `SELECT id, worker_id, lease_token FROM amazon_scan_jobs
     WHERE status IN ('RUNNING','CLAIMED') AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()
     ORDER BY lease_expires_at ASC LIMIT $1::int`,
    [limit]
  )
  let n = 0
  for (const row of rows.rows) {
    await failScanJob({
      jobId: Number(row.id),
      workerId: row.worker_id,
      leaseToken: row.lease_token,
      code: "WORKER_ERROR",
      message: "EXPIRED_RUNNING_RECOVERED",
    })
    n++
  }
  return n
}

export async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    return await fn(c)
  } finally {
    c.release()
  }
}
