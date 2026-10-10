import crypto from "crypto"
import { query, db } from "../../db/client"
import { loadAmazonScanConfig } from "../amazonScan/amazonScanConfig"
import { buildAmazonScanKey } from "../amazonScan/amazonScanKey"
import { completeScanJob, failScanJob, getScanJob, markScanJobRunning, type AmazonScanJobRow } from "../amazonScan/amazonScanJobQueue"
import { loadOxylabsVerifyConfig } from "./oxylabsVerifyConfig"
import { OXYLABS_PRODUCT_CONFIRM, OXYLABS_PRODUCT_PRIMARY, OXYLABS_PROVIDER, resolveOxylabsVerifyClaimKind } from "./oxylabsVerifyKinds"
import { isOxylabsTerminalFailCode, normalizeOxylabsFailCode } from "./oxylabsVerifyFailPolicy"
import { countOxylabsCallReservations, reserveOxylabsProviderCall } from "./oxylabsVerifyReservations"
import { mayOxylabsOwnerTerminalFail } from "./oxylabsExpiredClaim"
import { oxylabsBillingCycleWindow } from "./oxylabsBillingCycle"
import { loadOxylabsPlanUsage } from "./oxylabsPlanUsage"

const ACTIVE = ["PENDING", "CLAIMED", "RUNNING", "WAITING_FOR_WORKER", "RETRYABLE"]

export async function getOxylabsCanarySuccessCount(): Promise<number> {
  const res = await query<{ success_result_count: number }>(
    `SELECT success_result_count FROM oxylabs_verify_canary_state WHERE id = 1`
  )
  return Number(res.rows[0]?.success_result_count ?? 0) || 0
}

export async function incrementOxylabsCanarySuccessIfUnderCap(cap: number): Promise<{ incremented: boolean; count: number }> {
  const res = await query<{ success_result_count: number }>(
    `UPDATE oxylabs_verify_canary_state
     SET success_result_count = success_result_count + 1, updated_at = NOW()
     WHERE id = 1 AND success_result_count < $1::int
     RETURNING success_result_count`,
    [cap]
  )
  if (res.rows[0]) return { incremented: true, count: Number(res.rows[0].success_result_count) }
  return { incremented: false, count: await getOxylabsCanarySuccessCount() }
}

export async function enqueueOxylabsScanJob(input: {
  globalAsinId: number
  asin: string
  marketplace: string
  kind: typeof OXYLABS_PRODUCT_PRIMARY | typeof OXYLABS_PRODUCT_CONFIRM
  parentJobId?: number | null
  keepaCandidateId?: number | null
  priority?: number
}): Promise<{ jobId: number; created: boolean }> {
  const cfg = loadAmazonScanConfig()
  const oxy = loadOxylabsVerifyConfig()
  const scanKey = buildAmazonScanKey({
    asin: input.asin,
    marketplace: input.marketplace,
    deliveryZip: oxy.geoLocation,
    sessionClass: cfg.sessionClass,
  })
  if (input.kind !== OXYLABS_PRODUCT_PRIMARY) return { jobId: 0, created: false }
  const existing = await query<{ id: number }>(
    `SELECT id FROM amazon_scan_jobs
     WHERE scan_key = $1 AND kind = $2
       AND status = ANY($3::text[])
     LIMIT 1`,
    [scanKey, input.kind, ACTIVE]
  )
  if (existing.rows[0]) return { jobId: Number(existing.rows[0].id), created: false }

  const usage = await loadOxylabsPlanUsage()
  if (usage.remaining <= 0) return { jobId: 0, created: false }

  try {
    const res = await query<{ id: number }>(
      `INSERT INTO amazon_scan_jobs (
         scan_key, global_asin_id, asin, marketplace, delivery_zip, session_class,
         kind, provider, priority, status, available_at, parent_job_id, require_fresh_nav, keepa_candidate_id, created_at, updated_at
       ) VALUES (
         $1,$2::bigint,$3,$4,$5,$6,$7,$8,$9,'PENDING',NOW(),$10::bigint,TRUE,$11::bigint,NOW(),NOW()
       )
       RETURNING id`,
      [
        scanKey,
        input.globalAsinId,
        input.asin.trim().toUpperCase(),
        input.marketplace,
        oxy.geoLocation,
        cfg.sessionClass,
        input.kind,
        OXYLABS_PROVIDER,
        input.priority ?? 0,
        input.parentJobId ?? null,
        input.keepaCandidateId ?? null,
      ]
    )
    return { jobId: Number(res.rows[0].id), created: true }
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : ""
    if (code === "23505") {
      const again = await query<{ id: number }>(
        `SELECT id FROM amazon_scan_jobs
         WHERE scan_key = $1 AND kind = $2 AND status = ANY($3::text[])
         LIMIT 1`,
        [scanKey, input.kind, ACTIVE]
      )
      if (again.rows[0]) return { jobId: Number(again.rows[0].id), created: false }
    }
    throw e
  }
}

export async function claimNextOxylabsJob(input: { workerId: string; preferConfirm?: boolean }): Promise<
  | { job: AmazonScanJobRow; leaseToken: string; expiredRecovery: boolean }
  | { job: null; message: string }
> {
  const oxy = loadOxylabsVerifyConfig()
  if (!oxy.protocolEnabled || !oxy.claimEnabled) {
    return { job: null, message: "OXYLABS_VERIFY_CLAIM_DISABLED" }
  }
  const claimKind = resolveOxylabsVerifyClaimKind(input.workerId)
  if (!claimKind) {
    return { job: null, message: "UNKNOWN_WORKER" }
  }
  let cap = oxy.canaryMaxSuccessResults
  let cycleStart: Date | null = null
  let cycleEnd: Date | null = null
  if (oxy.planMode === "paid" && oxy.billingCycleAnchorAt) {
    const w = oxylabsBillingCycleWindow(oxy.billingCycleAnchorAt, new Date())
    cycleStart = w.start
    cycleEnd = w.end
    cap = oxy.monthlyResultLimit
  }
  void input.preferConfirm
  const leaseToken = crypto.randomBytes(24).toString("hex")
  const cfg = loadAmazonScanConfig()
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const busy = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM amazon_scan_jobs
       WHERE worker_id = $1
         AND status IN ('CLAIMED','RUNNING')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at > NOW()`,
      [input.workerId]
    )
    if ((parseInt(busy.rows[0]?.c ?? "0", 10) || 0) >= 1) {
      await client.query("COMMIT")
      return { job: null, message: "WORKER_BUSY" }
    }
    const recovered = await client.query(
      `WITH expired AS (
         SELECT t.id
         FROM amazon_scan_jobs t
         WHERE t.worker_id = $1
           AND t.status IN ('CLAIMED','RUNNING')
           AND t.kind = $4::text
           AND t.provider = $5::text
           AND (t.lease_expires_at IS NULL OR t.lease_expires_at < NOW())
         ORDER BY t.id ASC
         LIMIT 1
         FOR UPDATE OF t SKIP LOCKED
       )
       UPDATE amazon_scan_jobs t
       SET status = 'CLAIMED',
           lease_token = $2,
           lease_expires_at = NOW() + make_interval(secs => $3::int),
           updated_at = NOW()
       FROM expired
       WHERE t.id = expired.id
         AND t.worker_id = $1
         AND t.status IN ('CLAIMED','RUNNING')
       RETURNING t.*`,
      [input.workerId, leaseToken, cfg.leaseSeconds, claimKind, OXYLABS_PROVIDER]
    )
    if (recovered.rows[0]) {
      await client.query("COMMIT")
      const mapped = await getScanJob(Number(recovered.rows[0].id))
      if (!mapped) return { job: null, message: "NO_WORK" }
      return { job: mapped, leaseToken, expiredRecovery: true }
    }
    const claimed = await client.query(
      `WITH candidate AS (
         SELECT t.id
         FROM amazon_scan_jobs t
         WHERE t.status IN ('PENDING','RETRYABLE','WAITING_FOR_WORKER')
           AND t.available_at <= NOW()
           AND (t.lease_expires_at IS NULL OR t.lease_expires_at < NOW())
           AND t.kind = $4::text
           AND t.provider = $5::text
           AND (
             EXISTS (SELECT 1 FROM oxylabs_verify_call_reservations r WHERE r.job_id = t.id)
             OR (
               SELECT COUNT(*) FROM oxylabs_verify_call_reservations r
               WHERE ($7::timestamptz IS NULL)
                  OR (r.reserved_at >= $7::timestamptz AND r.reserved_at < $8::timestamptz)
             ) < $6::int
           )
         ORDER BY t.priority ASC, t.available_at ASC, t.id ASC
         LIMIT 1
         FOR UPDATE OF t SKIP LOCKED
       )
       UPDATE amazon_scan_jobs t
       SET status = 'CLAIMED',
           worker_id = $1,
           lease_token = $2,
           claimed_at = NOW(),
           started_at = COALESCE(t.started_at, NOW()),
           lease_expires_at = NOW() + make_interval(secs => $3::int),
           updated_at = NOW()
       FROM candidate
       WHERE t.id = candidate.id
         AND t.kind = $4::text
         AND t.provider = $5::text
       RETURNING t.*`,
      [input.workerId, leaseToken, cfg.leaseSeconds, claimKind, OXYLABS_PROVIDER, cap, cycleStart, cycleEnd]
    )
    const row = claimed.rows[0]
    if (!row) {
      await client.query("COMMIT")
      const used =
        cycleStart && cycleEnd
          ? (
              await query<{ c: string }>(
                `SELECT COUNT(*)::text AS c FROM oxylabs_verify_call_reservations
                 WHERE reserved_at >= $1::timestamptz AND reserved_at < $2::timestamptz`,
                [cycleStart.toISOString(), cycleEnd.toISOString()]
              )
            ).rows[0]
          : { c: String(await countOxylabsCallReservations()) }
      const usedN = parseInt(String((used as { c: string }).c ?? "0"), 10) || 0
      return { job: null, message: usedN >= cap ? "CANARY_CAP_REACHED" : "NO_WORK" }
    }
    const slot = await reserveOxylabsProviderCall({
      client,
      jobId: Number(row.id),
      workerId: input.workerId,
      cap,
      cycleStart,
      cycleEnd,
    })
    if (!slot.reserved) {
      await client.query(
        `UPDATE amazon_scan_jobs
         SET status = 'PENDING', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE id = $1::bigint AND status = 'CLAIMED'`,
        [row.id]
      )
      await client.query("COMMIT")
      return { job: null, message: "CANARY_CAP_REACHED" }
    }
    await client.query("COMMIT")
    const mapped = await getScanJob(Number(row.id))
    if (!mapped) return { job: null, message: "NO_WORK" }
    return { job: mapped, leaseToken, expiredRecovery: false }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

export async function completeOxylabsVerifyJob(input: {
  jobId: number
  workerId: string
  leaseToken: string
  payload: Record<string, unknown>
  observedAt: Date
}): Promise<{ ok: true; alreadyCompleted?: boolean } | { ok: false; code: string }> {
  const before = await getScanJob(input.jobId)
  const result = await completeScanJob(input)
  if (result.ok && !result.alreadyCompleted) {
    const oxy = loadOxylabsVerifyConfig()
    if (oxy.planMode === "paid") {
      await query(
        `UPDATE oxylabs_verify_canary_state
         SET success_result_count = success_result_count + 1, updated_at = NOW()
         WHERE id = 1`
      )
    } else {
      await incrementOxylabsCanarySuccessIfUnderCap(oxy.canaryMaxSuccessResults)
    }
  }
  void before
  return result
}

export async function failOxylabsVerifyJob(input: {
  jobId: number
  workerId: string
  leaseToken: string
  code: string
  message: string
}): Promise<{ status: string }> {
  const code = normalizeOxylabsFailCode(input.code)
  const existing = await query<{ status: string; failure_code: string | null }>(
    `SELECT status, failure_code FROM amazon_scan_jobs WHERE id = $1::bigint`,
    [input.jobId]
  )
  const row = existing.rows[0]
  if (!row) return { status: "MISSING" }
  if (row.status === "COMPLETED") return { status: "COMPLETED" }
  if (row.status === "FAILED" && isOxylabsTerminalFailCode(row.failure_code)) {
    return { status: "FAILED" }
  }
  if (isOxylabsTerminalFailCode(code)) {
    const owned = await query<{ worker_id: string | null; status: string }>(
      `SELECT worker_id, status FROM amazon_scan_jobs WHERE id = $1::bigint`,
      [input.jobId]
    )
    const job = owned.rows[0]
    if (
      !job ||
      !mayOxylabsOwnerTerminalFail({
        jobWorkerId: job.worker_id,
        requestWorkerId: input.workerId,
        status: job.status,
      })
    ) {
      return { status: "STALE_LEASE" }
    }
    const upd = await query(
      `UPDATE amazon_scan_jobs
       SET status = 'FAILED',
           worker_id = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           failure_code = $2,
           failure_message = $3,
           updated_at = NOW()
       WHERE id = $1::bigint
         AND worker_id = $4
         AND status IN ('CLAIMED','RUNNING')
       RETURNING id`,
      [input.jobId, code, input.message.slice(0, 400), input.workerId]
    )
    if (!upd.rowCount) return { status: "STALE_LEASE" }
    return { status: "FAILED" }
  }
  return failScanJob({ ...input, code })
}

export async function markOxylabsJobRunning(input: {
  jobId: number
  workerId: string
  leaseToken: string
}): Promise<boolean> {
  return markScanJobRunning(input)
}
