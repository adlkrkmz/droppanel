import type { PoolClient } from "pg"
import { db, query } from "../../db/client"
import { loadAmazonVerificationConfig } from "./amazonVerificationConfig"
import {
  nextVerificationRetryAt,
  shouldCreatePriceVerificationTask,
} from "./amazonVerificationPolicy"
import {
  deriveIsFba,
  derivePurchasable,
  isTrustedNewAmazonOffer,
  normalizeCondition,
  normalizeCurrency,
  normalizeDisplayedPrice,
  shipsFromAmazon,
  soldByAmazon,
} from "./amazonVerificationNormalize"
import { markWorkerCaptcha, markWorkerVerificationSuccess } from "./extensionWorkerRegistry"
import type {
  KeepaVerificationSignal,
  PurchasableTriState,
  VerificationReason,
  VerificationTaskStatus,
} from "./amazonVerificationTypes"

import { AMAZON_VERIFICATION_CLAIM_SQL } from "./amazonVerificationClaimSql"
import { resolveApplySourceAsin } from "../monitor/listingAsinResolve"

export type VerificationTaskRow = {
  id: number
  globalAsinId: number
  workspaceId: string
  preferredUserId: string
  catalogStateId: number
  asin: string
  amazonUrl: string
  reason: VerificationReason
  status: VerificationTaskStatus
  attemptCount: number
  leaseExpiresAt: Date | null
}

export type ClaimNextVerificationResult =
  | { ok: true; task: VerificationTaskRow }
  | { ok: true; task: null; message: "NO_WORK" }

async function findActiveTask(input: {
  workspaceId: string
  globalAsinId: number
  catalogStateId: number
}): Promise<{ id: number; status: VerificationTaskStatus } | null> {
  const res = await query<{ id: number; status: string }>(
    `SELECT id, status FROM amazon_price_verification_tasks
     WHERE workspace_id = $1::uuid
       AND global_asin_id = $2::bigint
       AND catalog_state_id = $3::bigint
       AND status IN ('PENDING','CLAIMED','RUNNING','WAITING_FOR_WORKER','RETRYABLE')
     LIMIT 1`,
    [input.workspaceId, input.globalAsinId, input.catalogStateId]
  )
  const row = res.rows[0]
  if (!row) return null
  return { id: row.id, status: row.status as VerificationTaskStatus }
}

export async function enqueueVerificationTask(input: {
  globalAsinId: number
  workspaceId: string
  preferredUserId: string
  catalogStateId: number
  asin: string
  amazonUrl?: string | null
  reason: VerificationReason
  priority?: number
  workerOnline?: boolean
}): Promise<{ taskId: number; created: boolean; status: VerificationTaskStatus }> {
  const existing = await findActiveTask({
    workspaceId: input.workspaceId,
    globalAsinId: input.globalAsinId,
    catalogStateId: input.catalogStateId,
  })
  if (existing != null) return { taskId: existing.id, created: false, status: existing.status }

  const asin = input.asin.trim().toUpperCase()
  const url =
    input.amazonUrl?.trim() || `https://www.amazon.com/dp/${encodeURIComponent(asin)}`
  const status: VerificationTaskStatus = input.workerOnline === false ? "WAITING_FOR_WORKER" : "PENDING"
  try {
    const res = await query<{ id: number }>(
      `INSERT INTO amazon_price_verification_tasks (
         global_asin_id, workspace_id, preferred_user_id, catalog_state_id,
         asin, amazon_url, reason, priority, status, available_at, created_at, updated_at
       ) VALUES (
         $1::bigint, $2::uuid, $3::uuid, $4::bigint,
         $5, $6, $7, $8, $9, NOW(), NOW(), NOW()
       )
       RETURNING id`,
      [
        input.globalAsinId,
        input.workspaceId,
        input.preferredUserId,
        input.catalogStateId,
        asin,
        url,
        input.reason,
        input.priority ?? 2,
        status,
      ]
    )
    const created = { taskId: Number(res.rows[0].id), created: true as const, status }
    await afterCreateVerificationTask({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
      asin,
      status,
      verificationSource: input.reason === "DESKTOP_AGENT" ? "DESKTOP_AGENT" : "SERVER",
    })
    return created
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : ""
    if (code === "23505") {
      const again = await findActiveTask({
        workspaceId: input.workspaceId,
        globalAsinId: input.globalAsinId,
        catalogStateId: input.catalogStateId,
      })
      if (again != null) return { taskId: again.id, created: false, status: again.status }
    }
    throw e
  }
}

async function afterCreateVerificationTask(input: {
  workspaceId: string
  catalogStateId: number
  asin: string
  status: VerificationTaskStatus
  verificationSource: "SERVER" | "DESKTOP_AGENT"
}): Promise<void> {
  const { syncReviewAfterVerificationEnqueue } = await import("../stockAlerts/stockAlertReviewLifecycle")
  await syncReviewAfterVerificationEnqueue({
    workspaceId: input.workspaceId,
    catalogStateId: input.catalogStateId,
    asin: input.asin,
    waitingForWorker: input.status === "WAITING_FOR_WORKER",
    verificationSource: input.verificationSource,
  }).catch(() => undefined)
}

export async function claimNextVerificationTask(input: {
  workspaceId: string
  userId: string
  workerId: string
}): Promise<ClaimNextVerificationResult> {
  const cfg = loadAmazonVerificationConfig()
  const allowAllReasons = cfg.verificationEnabled === true
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const busy = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM amazon_price_verification_tasks
       WHERE worker_id = $1
         AND status IN ('CLAIMED','RUNNING')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at > NOW()`,
      [input.workerId]
    )
    if ((parseInt(busy.rows[0]?.c ?? "0", 10) || 0) >= cfg.maxConcurrentTasksPerWorker) {
      await client.query("COMMIT")
      return { ok: true, task: null, message: "NO_WORK" }
    }
    const claimed = await client.query<{
      id: number
      global_asin_id: string
      workspace_id: string
      preferred_user_id: string
      catalog_state_id: string
      asin: string
      amazon_url: string
      reason: VerificationReason
      status: VerificationTaskStatus
      attempt_count: number
      lease_expires_at: Date | null
    }>(AMAZON_VERIFICATION_CLAIM_SQL, [
      input.workspaceId,
      input.userId,
      input.workerId,
      cfg.leaseSeconds,
      allowAllReasons,
    ])
    const row = claimed.rows[0]
    if (!row) {
      await client.query("COMMIT")
      return { ok: true, task: null, message: "NO_WORK" }
    }
    await client.query(
      `UPDATE extension_workers
       SET current_task_id = $2::bigint,
           active_task_count = 1,
           updated_at = NOW()
       WHERE worker_id = $1`,
      [input.workerId, row.id]
    )
    await client.query("COMMIT")
    return {
      ok: true,
      task: {
        id: Number(row.id),
        globalAsinId: Number(row.global_asin_id),
        workspaceId: row.workspace_id,
        preferredUserId: row.preferred_user_id,
        catalogStateId: Number(row.catalog_state_id),
        asin: row.asin,
        amazonUrl: row.amazon_url,
        reason: row.reason,
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

export async function markVerificationRunning(input: {
  taskId: number
  workspaceId: string
  userId: string
  workerId: string
}): Promise<boolean> {
  const res = await query(
    `UPDATE amazon_price_verification_tasks
     SET status = 'RUNNING', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
     WHERE id = $1::bigint
       AND workspace_id = $2::uuid
       AND preferred_user_id = $3::uuid
       AND worker_id = $4
       AND status IN ('CLAIMED','RUNNING')`,
    [input.taskId, input.workspaceId, input.userId, input.workerId]
  )
  return (res.rowCount ?? 0) > 0
}

export type VerificationResultPayload = {
  asin?: string
  requestedAsin?: string
  finalAsin?: string
  displayedPrice?: unknown
  currency?: unknown
  condition?: unknown
  shipsFrom?: unknown
  soldBy?: unknown
  isPrime?: unknown
  isFba?: unknown
  purchasable?: unknown
  hasAddToCart?: unknown
  hasBuyNow?: unknown
  availabilityText?: unknown
  stockStatus?: unknown
  pageUrl?: unknown
  captcha?: unknown
  loginRequired?: unknown
  pageUnavailable?: unknown
  redirected?: unknown
  primeExclusive?: unknown
  metadata?: Record<string, unknown>
}

function payloadFingerprint(result: {
  price: number | null
  condition: string | null
  isPrime: boolean | null
  shipsFromAmazon: boolean | null
}): string {
  return `${result.price ?? ""}|${result.condition ?? ""}|${String(result.isPrime)}|${String(result.shipsFromAmazon)}`
}

export async function submitVerificationResult(input: {
  taskId: number
  workspaceId: string
  userId: string
  workerId: string
  payload: VerificationResultPayload
  /** Defaults to EXTENSION_VERIFIED for extension/public-worker paths. */
  confirmationSource?: "KEEPA_CONFIRMED" | "EXTENSION_VERIFIED" | "DESKTOP_AGENT" | "SERVER_BROWSER_PUBLIC" | "SERVER_BROWSER_AUTH"
}): Promise<{ ok: true; status: VerificationTaskStatus; alreadyCompleted?: boolean; trustedNewAmazonOffer: boolean }> {
  const confirmationSource = input.confirmationSource ?? "EXTENSION_VERIFIED"
  const sourceFromTask = (claimedBySource: string | null): typeof confirmationSource => {
    if (claimedBySource === "SERVER_BROWSER_AUTH") return "SERVER_BROWSER_AUTH"
    if (claimedBySource === "SERVER_BROWSER") return "SERVER_BROWSER_PUBLIC"
    if (claimedBySource === "DESKTOP_AGENT") return "DESKTOP_AGENT"
    return confirmationSource
  }
  const existing = await query<{
    status: VerificationTaskStatus
    worker_id: string | null
    preferred_user_id: string
    workspace_id: string
    asin: string
    result_price: string | null
    result_condition: string | null
    result_is_prime: boolean | null
    result_ships_from_amazon: boolean | null
    claimed_by_source: string | null
    lease_expires_at: Date | null
  }>(
    `SELECT status, worker_id, preferred_user_id::text AS preferred_user_id,
            workspace_id::text AS workspace_id, asin, result_price::text,
            result_condition, result_is_prime, result_ships_from_amazon, claimed_by_source, lease_expires_at
     FROM amazon_price_verification_tasks WHERE id = $1::bigint`,
    [input.taskId]
  )
  const row = existing.rows[0]
  if (!row) throw Object.assign(new Error("Task not found"), { status: 404 })
  if (row.workspace_id !== input.workspaceId || row.preferred_user_id !== input.userId) {
    throw Object.assign(new Error("Forbidden"), { status: 403 })
  }

  const verificationSource = sourceFromTask(row.claimed_by_source)
  const sold = soldByAmazon(input.payload.soldBy)
  // Seller alone is not fulfillment evidence — do not infer ships-from from sold-by.
  const ships = shipsFromAmazon(input.payload.shipsFrom)
  // Fail-safe: never coerce null ships → isFba false (false NOT_FBA)
  const isFba = deriveIsFba({
    shipsFromAmazon: ships,
    soldByAmazon: sold,
    isFba: typeof input.payload.isFba === "boolean" ? input.payload.isFba : null,
  })
  const meta =
    input.payload.metadata && typeof input.payload.metadata === "object"
      ? (input.payload.metadata as Record<string, unknown>)
      : {}
  const hasMerchantBits =
    (typeof input.payload.shipsFrom === "string" && input.payload.shipsFrom.trim().length > 0) ||
    (typeof input.payload.soldBy === "string" && input.payload.soldBy.trim().length > 0)
  // Prefer mapper/extract flag; otherwise require merchant chrome (price alone is not enough)
  const offerPageHealthy =
    typeof meta.offerPageHealthy === "boolean"
      ? meta.offerPageHealthy === true
      : hasMerchantBits
  const price = normalizeDisplayedPrice(input.payload.displayedPrice)
  const condition = normalizeCondition(input.payload.condition)
  const isPrime = typeof input.payload.isPrime === "boolean" ? input.payload.isPrime : null
  const purchasable: PurchasableTriState =
    input.payload.purchasable === "TRUE" || input.payload.purchasable === "FALSE" || input.payload.purchasable === "UNKNOWN"
      ? input.payload.purchasable
      : derivePurchasable({
          hasAddToCart: input.payload.hasAddToCart === true,
          hasBuyNow: input.payload.hasBuyNow === true,
          availabilityText: typeof input.payload.availabilityText === "string" ? input.payload.availabilityText : null,
          stockStatus: typeof input.payload.stockStatus === "string" ? input.payload.stockStatus : null,
        })
  const trusted = isTrustedNewAmazonOffer({ condition, shipsFromAmazon: ships })

  if (row.status === "COMPLETED") {
    const same =
      payloadFingerprint({
        price,
        condition,
        isPrime,
        shipsFromAmazon: ships,
      }) ===
      payloadFingerprint({
        price: row.result_price != null ? Number(row.result_price) : null,
        condition: row.result_condition,
        isPrime: row.result_is_prime,
        shipsFromAmazon: row.result_ships_from_amazon,
      })
    if (same) {
      try {
        const { applyVerifiedSourceResult } = await import("../stockGuard/verifiedStockActionService")
        await applyVerifiedSourceResult({
          workspaceId: input.workspaceId,
          userId: input.userId,
          taskId: input.taskId,
          alreadyCompleted: true,
          confirmationSource: verificationSource,
          payload: {
            requestedAsin: row.asin,
            displayedPrice: price,
            condition,
            isPrime,
            isFba,
            shipsFromAmazon: ships,
            purchasable,
            stockStatus: typeof input.payload.stockStatus === "string" ? input.payload.stockStatus : null,
            availabilityText:
              typeof input.payload.availabilityText === "string" ? input.payload.availabilityText : null,
            pageUnavailable: input.payload.pageUnavailable === true,
            offerPageHealthy,
          },
        })
      } catch {
        /* idempotent apply must not fail the result ACK */
      }
      return { ok: true, status: "COMPLETED", alreadyCompleted: true, trustedNewAmazonOffer: trusted }
    }
    throw Object.assign(new Error("Task already completed"), { status: 409 })
  }

  if (row.worker_id !== input.workerId) {
    throw Object.assign(new Error("WRONG_WORKER"), { status: 403 })
  }
  if (row.status !== "CLAIMED" && row.status !== "RUNNING") {
    throw Object.assign(new Error("Task is not claimed"), { status: 409 })
  }

  const submittedAsin = typeof input.payload.asin === "string" ? input.payload.asin.trim().toUpperCase() : ""
  const requestedAsin = typeof input.payload.requestedAsin === "string" ? input.payload.requestedAsin.trim().toUpperCase() : row.asin
  const finalAsin = typeof input.payload.finalAsin === "string" ? input.payload.finalAsin.trim().toUpperCase() : submittedAsin
  const redirected =
    input.payload.redirected === true || (Boolean(finalAsin) && finalAsin !== row.asin) || (Boolean(submittedAsin) && submittedAsin !== row.asin)

  const availabilityText =
    typeof input.payload.availabilityText === "string" ? input.payload.availabilityText : null
  const metadata = {
    ...(input.payload.metadata ?? {}),
    primeExclusive: input.payload.primeExclusive ?? null,
    soldBy: typeof input.payload.soldBy === "string" ? input.payload.soldBy : null,
    shipsFrom: typeof input.payload.shipsFrom === "string" ? input.payload.shipsFrom : null,
    requestedAsin,
    finalAsin: finalAsin || submittedAsin || null,
    redirected,
    pageUnavailable: input.payload.pageUnavailable === true,
    // Audit: keep observation evidence in JSON metadata (no schema change)
    availabilityText:
      availabilityText ??
      (typeof meta.availabilityText === "string" ? meta.availabilityText : null),
    publicStatus: meta.publicStatus ?? null,
    publicOfferCondition: meta.publicOfferCondition ?? null,
    publicNewOfferAvailable:
      typeof meta.publicNewOfferAvailable === "boolean" ? meta.publicNewOfferAvailable : null,
    deliveryZip: meta.deliveryZip ?? meta.usDeliveryZip ?? null,
    deliveryLocation: meta.deliveryLocation ?? null,
    offerPageHealthy,
    shipsFromAmazon: ships,
  }

  await query(
    `UPDATE amazon_price_verification_tasks
     SET status = 'COMPLETED',
         completed_at = NOW(),
         lease_expires_at = NULL,
         result_price = $2::numeric,
         result_currency = $3::text,
         result_condition = $4::text,
         result_is_prime = $5::boolean,
         result_is_fba = $6::boolean,
         result_ships_from_amazon = $7::boolean,
         result_purchasable = $8::text,
         result_source_url = $9::text,
         result_metadata = $10::jsonb,
         failure_code = NULL,
         failure_message = NULL,
         updated_at = NOW()
     WHERE id = $1::bigint
       AND workspace_id = $11::uuid
       AND preferred_user_id = $12::uuid
       AND worker_id = $13
       AND status IN ('CLAIMED','RUNNING')`,
    [
      input.taskId,
      price,
      normalizeCurrency(input.payload.currency),
      condition,
      isPrime,
      isFba,
      ships,
      purchasable,
      typeof input.payload.pageUrl === "string" ? input.payload.pageUrl : null,
      JSON.stringify(metadata),
      input.workspaceId,
      input.userId,
      input.workerId,
    ]
  )
  await markWorkerVerificationSuccess(input.workerId)
  try {
    const { applyVerifiedSourceResult } = await import("../stockGuard/verifiedStockActionService")
    await applyVerifiedSourceResult({
      workspaceId: input.workspaceId,
      userId: input.userId,
      taskId: input.taskId,
      confirmationSource: verificationSource,
      payload: {
        requestedAsin: row.asin,
        finalAsin: finalAsin || submittedAsin || undefined,
        displayedPrice: price,
        condition,
        isPrime,
        isFba,
        shipsFromAmazon: ships,
        purchasable,
        stockStatus: typeof input.payload.stockStatus === "string" ? input.payload.stockStatus : null,
        availabilityText:
          typeof input.payload.availabilityText === "string" ? input.payload.availabilityText : null,
        pageUnavailable: input.payload.pageUnavailable === true,
        redirected,
        captcha: input.payload.captcha === true,
        loginRequired: input.payload.loginRequired === true,
        offerPageHealthy,
      },
    })
  } catch (e) {
    console.warn("[verification] apply source decision skipped:", e instanceof Error ? e.message : e)
  }
  return { ok: true, status: "COMPLETED", trustedNewAmazonOffer: trusted }
}

export async function failVerificationTask(input: {
  taskId: number
  workspaceId: string
  userId: string
  workerId: string
  code: string
  message: string
  /** Keep a PRICE_MISSING auth exception out of the public claim pool. */
  preserveClaimedBySource?: 'SERVER_BROWSER_AUTH'
}): Promise<{ ok: true; status: VerificationTaskStatus }> {
  const cfg = loadAmazonVerificationConfig()
  const row = await query<{
    attempt_count: number
    status: VerificationTaskStatus
    worker_id: string | null
    preferred_user_id: string
    workspace_id: string
    catalog_state_id: string
    reason: VerificationReason
  }>(
    `SELECT attempt_count, status, worker_id,
            preferred_user_id::text AS preferred_user_id, workspace_id::text AS workspace_id,
            catalog_state_id::text AS catalog_state_id, reason
     FROM amazon_price_verification_tasks WHERE id = $1::bigint`,
    [input.taskId]
  )
  const task = row.rows[0]
  if (!task) throw Object.assign(new Error("Task not found"), { status: 404 })
  if (task.workspace_id !== input.workspaceId || task.preferred_user_id !== input.userId) {
    throw Object.assign(new Error("Forbidden"), { status: 403 })
  }
  if (task.worker_id !== input.workerId) {
    throw Object.assign(new Error("WRONG_WORKER"), { status: 403 })
  }
  if (task.status === "COMPLETED") return { ok: true, status: "COMPLETED" }

  const code = input.code.slice(0, 80)
  const preserveAuthFallback = input.preserveClaimedBySource === 'SERVER_BROWSER_AUTH'
  if (
    code === "CAPTCHA" ||
    code === "LOGIN_REQUIRED" ||
    code === "CHALLENGE_REQUIRED" ||
    code === "ACCOUNT_CHALLENGE" ||
    code === "AMAZON_SESSION_UNAVAILABLE"
  ) {
    if (code === "CAPTCHA") await markWorkerCaptcha(input.workerId)
    await query(
      `UPDATE amazon_price_verification_tasks
       SET status = 'WAITING_FOR_WORKER',
           worker_id = NULL,
           claimed_by_source = CASE WHEN $4::boolean THEN 'SERVER_BROWSER_AUTH' ELSE NULL END,
           lease_expires_at = NULL,
           failure_code = $2,
           failure_message = $3,
           available_at = NOW() + interval '30 minutes',
           updated_at = NOW()
       WHERE id = $1::bigint`,
      [input.taskId, code, input.message.slice(0, 400), preserveAuthFallback]
    )
    if (task.reason !== "DESKTOP_AGENT") {
      const { syncReviewAfterVerificationEnqueue } = await import("../stockAlerts/stockAlertReviewLifecycle")
      await syncReviewAfterVerificationEnqueue({
        workspaceId: input.workspaceId,
        catalogStateId: Number(task.catalog_state_id),
        asin: "",
        waitingForWorker: true,
        verificationSource: "SERVER",
      }).catch(() => undefined)
    }
    return { ok: true, status: "WAITING_FOR_WORKER" }
  }

  const attempt = (task.attempt_count || 0) + 1
  const terminal = attempt >= cfg.maxAttempts
  const next = nextVerificationRetryAt({ now: new Date(), attemptCount: attempt })
  await query(
    `UPDATE amazon_price_verification_tasks
     SET status = $2,
         attempt_count = $3,
         worker_id = NULL,
         claimed_by_source = CASE WHEN $7::boolean THEN 'SERVER_BROWSER_AUTH' ELSE NULL END,
         lease_expires_at = NULL,
         failure_code = $4,
         failure_message = $5,
         available_at = $6::timestamptz,
         updated_at = NOW()
     WHERE id = $1::bigint`,
    [
      input.taskId,
      terminal ? "FAILED" : "RETRYABLE",
      attempt,
      terminal ? "MAX_ATTEMPTS_EXCEEDED" : code,
      input.message.slice(0, 400),
      terminal ? new Date() : next,
      preserveAuthFallback,
    ]
  )
  if (task.reason !== "DESKTOP_AGENT") {
    const { syncReviewAfterVerificationFailure } = await import("../stockAlerts/stockAlertReviewLifecycle")
    await syncReviewAfterVerificationFailure({
      workspaceId: input.workspaceId,
      catalogStateId: Number(task.catalog_state_id),
      terminal,
      code: terminal ? "MAX_ATTEMPTS_EXCEEDED" : code,
      message: input.message,
    }).catch(() => undefined)
  }
  return { ok: true, status: terminal ? "FAILED" : "RETRYABLE" }
}

/**
 * Independent recovery for lease-expired RUNNING server-browser tasks.
 * Uses the same attempt/backoff path as failVerificationTask.
 * Does not require a new claim to run.
 */
/** Route the current public task to the authenticated Prime-only exception worker. */
export async function routePriceMissingToAuthenticatedWorker(input: {
  taskId: number
  workspaceId: string
  userId: string
  workerId: string
  originalReason?: string | null
}): Promise<boolean> {
  const res = await query(
    `UPDATE amazon_price_verification_tasks
     SET status = 'PENDING',
         reason = 'PRICE_MISSING',
         worker_id = NULL,
         claimed_by_source = 'SERVER_BROWSER_AUTH',
         lease_expires_at = NULL,
         failure_code = 'PRICE_MISSING_AUTH_FALLBACK',
         failure_message = $5::text,
         available_at = NOW(),
         updated_at = NOW()
     WHERE id = $1::bigint
       AND workspace_id = $2::uuid
       AND preferred_user_id = $3::uuid
       AND worker_id = $4::text
       AND status IN ('CLAIMED', 'RUNNING')`,
    [
      input.taskId,
      input.workspaceId,
      input.userId,
      input.workerId,
      `Public price missing; auth Prime fallback requested${input.originalReason ? ` from ${input.originalReason}` : ''}`,
    ]
  )
  return (res.rowCount ?? 0) > 0
}

/** Release an auth exception without making it eligible for the public worker. */
export async function releaseAuthenticatedPriceFallbackTask(input: {
  taskId: number
  workerId: string
  delayMinutes?: number
}): Promise<void> {
  const delay = Math.max(1, Math.min(120, input.delayMinutes ?? 30))
  await query(
    `UPDATE amazon_price_verification_tasks
     SET status = 'WAITING_FOR_WORKER',
         worker_id = NULL,
         claimed_by_source = 'SERVER_BROWSER_AUTH',
         lease_expires_at = NULL,
         available_at = NOW() + make_interval(mins => $3::int),
         updated_at = NOW()
     WHERE id = $1::bigint
       AND worker_id = $2::text
       AND status IN ('CLAIMED', 'RUNNING')`,
    [input.taskId, input.workerId, delay]
  )
}

/** Auth worker claim: only explicitly routed PRICE_MISSING exception rows. */
export async function claimNextAuthenticatedPriceFallbackTask(input: {
  workerId: string
}): Promise<ClaimNextVerificationResult> {
  const cfg = loadAmazonVerificationConfig()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const busy = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM amazon_price_verification_tasks
       WHERE worker_id = $1
         AND status IN ('CLAIMED', 'RUNNING')`,
      [input.workerId]
    )
    if ((parseInt(busy.rows[0]?.c ?? '0', 10) || 0) >= 1) {
      await client.query('COMMIT')
      return { ok: true, task: null, message: 'NO_WORK' }
    }
    const claimed = await client.query<{
      id: number
      global_asin_id: string
      workspace_id: string
      preferred_user_id: string
      catalog_state_id: string
      asin: string
      amazon_url: string
      reason: VerificationReason
      status: VerificationTaskStatus
      attempt_count: number
      lease_expires_at: Date | null
    }>(
      `WITH candidate AS (
         SELECT t.id
         FROM amazon_price_verification_tasks t
         WHERE t.status IN ('PENDING', 'RETRYABLE', 'WAITING_FOR_WORKER')
           AND t.reason = 'PRICE_MISSING'
           AND t.claimed_by_source = 'SERVER_BROWSER_AUTH'
           AND t.available_at <= NOW()
           AND (t.lease_expires_at IS NULL OR t.lease_expires_at < NOW())
         ORDER BY t.priority ASC, t.available_at ASC NULLS FIRST, t.id ASC
         LIMIT 1
         FOR UPDATE OF t SKIP LOCKED
       )
       UPDATE amazon_price_verification_tasks t
       SET status = 'CLAIMED',
           worker_id = $1::text,
           claimed_by_source = 'SERVER_BROWSER_AUTH',
           claimed_at = NOW(),
           started_at = COALESCE(t.started_at, NOW()),
           lease_expires_at = NOW() + make_interval(secs => $2::int),
           updated_at = NOW()
       FROM candidate
       WHERE t.id = candidate.id
       RETURNING t.id, t.global_asin_id, t.workspace_id::text AS workspace_id,
                 t.preferred_user_id::text AS preferred_user_id, t.catalog_state_id,
                 t.asin, t.amazon_url, t.reason, t.status, t.attempt_count,
                 t.lease_expires_at`,
      [input.workerId, cfg.leaseSeconds]
    )
    const row = claimed.rows[0]
    if (!row) {
      await client.query('COMMIT')
      return { ok: true, task: null, message: 'NO_WORK' }
    }
    await client.query('COMMIT')
    return {
      ok: true,
      task: {
        id: Number(row.id),
        globalAsinId: Number(row.global_asin_id),
        workspaceId: row.workspace_id,
        preferredUserId: row.preferred_user_id,
        catalogStateId: Number(row.catalog_state_id),
        asin: row.asin,
        amazonUrl: row.amazon_url,
        reason: row.reason,
        status: 'CLAIMED',
        attemptCount: Number(row.attempt_count) || 0,
        leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
      },
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

/** Read-only readiness check for the authenticated exception queue. */
export async function countClaimableAuthenticatedPriceFallbackTasks(): Promise<number> {
  const res = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM amazon_price_verification_tasks
     WHERE status IN ('PENDING', 'RETRYABLE', 'WAITING_FOR_WORKER')
       AND reason = 'PRICE_MISSING'
       AND claimed_by_source = 'SERVER_BROWSER_AUTH'
       AND available_at <= NOW()
       AND (lease_expires_at IS NULL OR lease_expires_at < NOW())`
  )
  return parseInt(res.rows[0]?.c ?? '0', 10) || 0
}

/** Recover only auth fallback rows; preserves auth ownership on retry. */
export async function recoverExpiredRunningAuthenticatedPriceTasks(input?: {
  workerId?: string
  limit?: number
}): Promise<{ recovered: number; taskIds: number[] }> {
  const workerId = input?.workerId?.trim() || null
  const limit = Math.max(1, Math.min(50, input?.limit ?? 20))
  const rows = await query<{
    id: number
    asin: string
    workspace_id: string
    preferred_user_id: string
    worker_id: string
    attempt_count: number
  }>(
    `SELECT id, asin,
            workspace_id::text AS workspace_id,
            preferred_user_id::text AS preferred_user_id,
            worker_id, attempt_count
     FROM amazon_price_verification_tasks
     WHERE status = 'RUNNING'
       AND reason = 'PRICE_MISSING'
       AND claimed_by_source = 'SERVER_BROWSER_AUTH'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < NOW()
       AND ($1::text IS NULL OR worker_id = $1::text)
     ORDER BY lease_expires_at ASC, id ASC
     LIMIT $2::int`,
    [workerId, limit]
  )
  const taskIds: number[] = []
  for (const row of rows.rows) {
    try {
      await failVerificationTask({
        taskId: Number(row.id),
        workspaceId: row.workspace_id,
        userId: row.preferred_user_id,
        workerId: row.worker_id,
        code: 'WORKER_ERROR',
        message: 'EXPIRED_RUNNING_RECOVERED: auth price fallback lease expired',
        preserveClaimedBySource: 'SERVER_BROWSER_AUTH',
      })
      taskIds.push(Number(row.id))
    } catch (e) {
      console.error(
        `[amazon-auth-price-worker] EXPIRED_RUNNING_RECOVERY_FAILED task_id=${row.id} asin=${row.asin}:`,
        e instanceof Error ? e.message : e
      )
    }
  }
  return { recovered: taskIds.length, taskIds }
}

export async function recoverExpiredRunningServerBrowserTasks(input?: {
  workerId?: string
  limit?: number
}): Promise<{ recovered: number; taskIds: number[] }> {
  const workerId = input?.workerId?.trim() || null
  const limit = Math.max(1, Math.min(50, input?.limit ?? 20))
  const rows = await query<{
    id: number
    asin: string
    workspace_id: string
    preferred_user_id: string
    worker_id: string
    attempt_count: number
  }>(
    `SELECT id, asin,
            workspace_id::text AS workspace_id,
            preferred_user_id::text AS preferred_user_id,
            worker_id,
            attempt_count
     FROM amazon_price_verification_tasks
     WHERE status = 'RUNNING'
       AND claimed_by_source = 'SERVER_BROWSER'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < NOW()
       AND ($1::text IS NULL OR worker_id = $1::text)
     ORDER BY lease_expires_at ASC, id ASC
     LIMIT $2::int`,
    [workerId, limit]
  )

  const taskIds: number[] = []
  for (const row of rows.rows) {
    try {
      await failVerificationTask({
        taskId:     Number(row.id),
        workspaceId: row.workspace_id,
        userId:      row.preferred_user_id,
        workerId:    row.worker_id,
        code:        "WORKER_ERROR",
        message:     "EXPIRED_RUNNING_RECOVERED: lease expired while RUNNING",
      })
      taskIds.push(Number(row.id))
      console.log(
        `[amazon-browser-worker] EXPIRED_RUNNING_RECOVERED task_id=${row.id} asin=${row.asin} ` +
          `attempt_count=${(Number(row.attempt_count) || 0) + 1} reason=lease_expired`
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(
        `[amazon-browser-worker] EXPIRED_RUNNING_RECOVERY_FAILED task_id=${row.id} asin=${row.asin}: ${msg}`
      )
    }
  }
  return { recovered: taskIds.length, taskIds }
}

export async function countPendingVerificationTasks(): Promise<number> {
  const res = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM amazon_price_verification_tasks
     WHERE status IN ('PENDING','RETRYABLE','WAITING_FOR_WORKER')`
  )
  return parseInt(res.rows[0]?.c ?? "0", 10) || 0
}

/** Keepa backpressure: AUTH backlog must not fill the public enqueue cap. */
export async function countPublicPendingVerificationTasks(): Promise<number> {
  const res = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM amazon_price_verification_tasks
     WHERE status IN ('PENDING','RETRYABLE','WAITING_FOR_WORKER')
       AND claimed_by_source IS DISTINCT FROM 'SERVER_BROWSER_AUTH'`
  )
  return parseInt(res.rows[0]?.c ?? "0", 10) || 0
}

/**
 * Tasks the SERVER_BROWSER claim SQL would accept right now
 * (same filters as AMAZON_VERIFICATION_SERVER_CLAIM_SQL candidate CTE; no mutate).
 */
export async function countClaimableVerificationTasks(input?: {
  allowAllReasons?: boolean
}): Promise<number> {
  const allowAllReasons = input?.allowAllReasons !== false
  const res = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM amazon_price_verification_tasks t
     WHERE t.status IN ('PENDING', 'RETRYABLE', 'WAITING_FOR_WORKER')
       AND t.available_at <= NOW()
       AND (t.lease_expires_at IS NULL OR t.lease_expires_at < NOW())
       AND t.claimed_by_source IS DISTINCT FROM 'SERVER_BROWSER_AUTH'
       AND ($1::boolean = true OR t.reason = 'ADMIN_TEST')`,
    [allowAllReasons]
  )
  return parseInt(res.rows[0]?.c ?? "0", 10) || 0
}

/** RETRYABLE rows still waiting on available_at backoff. */
export async function countRetryBackoffVerificationTasks(): Promise<number> {
  const res = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM amazon_price_verification_tasks
     WHERE status = 'RETRYABLE'
       AND available_at > NOW()`
  )
  return parseInt(res.rows[0]?.c ?? "0", 10) || 0
}

/** Earliest future available_at among RETRYABLE backoff tasks. */
export async function getNextRetryAvailableAt(): Promise<Date | null> {
  const res = await query<{ next_at: Date | null }>(
    `SELECT MIN(available_at) AS next_at
     FROM amazon_price_verification_tasks
     WHERE status = 'RETRYABLE'
       AND available_at > NOW()`
  )
  const v = res.rows[0]?.next_at
  return v ? new Date(v) : null
}

export async function countKeepaFallbackTasksLastMinute(): Promise<number> {
  const res = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM amazon_price_verification_tasks
     WHERE reason IN (
      'PRICE_AMBIGUOUS','KEEPA_PRODUCT_UNRESOLVED','KEEPA_UNRESOLVED',
      'PRICE_CHANGED','PRICE_MISSING','FBA_SIGNAL_LOST','FBM_ONLY','SOURCE_STALE'
    )
       AND created_at >= NOW() - interval '1 minute'`
  )
  return parseInt(res.rows[0]?.c ?? "0", 10) || 0
}

async function keepaShouldSkipProductNotReturnedEnqueue(input: {
  catalogStateId: number
  asin: string
}): Promise<boolean> {
  const asin = input.asin.trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) return false

  const listing = await query<{
    ebay_quantity: string | null
    bot_zeroed_at: Date | string | null
    last_verified_asin: string | null
    last_verified_decision: string | null
    bot_zeroed_reason: string | null
    registry_asin: string | null
    source_url: string | null
    internal_sku: string | null
  }>(
    `SELECT scs.ebay_quantity::text,
            scs.bot_zeroed_at,
            scs.last_verified_asin,
            scs.last_verified_decision,
            scs.bot_zeroed_reason,
            ar.asin AS registry_asin,
            scs.source_url,
            scs.internal_sku
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.id = $1::bigint
     LIMIT 1`,
    [input.catalogStateId]
  )
  const cat = listing.rows[0]
  if (!cat) return false

  const consumer = await query<{ consumer_asin: string | null }>(
    `SELECT g.asin AS consumer_asin
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     WHERE c.catalog_state_id = $1::bigint
     LIMIT 1`,
    [input.catalogStateId]
  )
  const currentAsin = resolveApplySourceAsin({
    registryAsin: cat.registry_asin,
    sourceUrl: cat.source_url,
    internalSku: cat.internal_sku?.trim() ?? "",
    consumerAsin: consumer.rows[0]?.consumer_asin ?? null,
  })
  if (currentAsin && currentAsin !== asin) return false

  const qty = cat.ebay_quantity != null ? Number(cat.ebay_quantity) : 0
  if (Number.isFinite(qty) && qty > 0 && cat.bot_zeroed_at) return false

  const confirmedTask = await query(
    `SELECT 1 AS ok
     FROM amazon_price_verification_tasks
     WHERE catalog_state_id = $1::bigint
       AND UPPER(BTRIM(asin)) = $2
       AND status = 'COMPLETED'
       AND COALESCE(result_metadata->>'pageUnavailable', 'false') IN ('true', 't')
     LIMIT 1`,
    [input.catalogStateId, asin]
  )
  if (confirmedTask.rows[0]) return true

  const lastAsin = String(cat.last_verified_asin ?? "").trim().toUpperCase()
  const reason = String(cat.bot_zeroed_reason ?? "").trim().toUpperCase()
  return (
    cat.last_verified_decision === "CONFIRMED_NO_VALID_SOURCE" &&
    lastAsin === asin &&
    (reason === "PRODUCT_NOT_FOUND" || reason === "ASIN_REMOVED" || reason === "PRODUCT_UNAVAILABLE")
  )
}

export async function enqueueFromKeepaSignal(input: {
  signal: KeepaVerificationSignal
  keepaFailureCount: number
  keepaOutage: boolean
  globalAsinId: number
  workspaceId: string
  preferredUserId: string
  catalogStateId: number
  asin: string
  amazonUrl?: string | null
  workerOnline?: boolean
}): Promise<{ created: boolean; taskId: number | null; code: string; status?: VerificationTaskStatus; duplicate?: boolean }> {
  if (input.signal === "PRODUCT_NOT_RETURNED") {
    if (
      await keepaShouldSkipProductNotReturnedEnqueue({
        catalogStateId: input.catalogStateId,
        asin: input.asin,
      })
    ) {
      return { created: false, taskId: null, code: "CONFIRMED_PRODUCT_NOT_FOUND" }
    }
  }
  const cfg = loadAmazonVerificationConfig()
  const decision = shouldCreatePriceVerificationTask({
    signal: input.signal,
    keepaFailureCount: input.keepaFailureCount,
    dispatchEnabled: cfg.keepaDispatchEnabled,
    verificationEnabled: cfg.verificationEnabled || cfg.serverBrowserEnabled,
    keepaOutage: input.keepaOutage,
    pendingTaskCount: await countPublicPendingVerificationTasks(),
    fallbackTasksLastMinute: await countKeepaFallbackTasksLastMinute(),
    keepaMaxRetries: cfg.keepaMaxRetries,
    maxPending: cfg.keepaFallbackMaxPendingTasks,
    maxPerMinute: cfg.keepaFallbackMaxTasksPerMinute,
    source: "planner",
  })
  if (!decision.create || !decision.reason) {
    return { created: false, taskId: null, code: decision.code }
  }
  let workerOnline = input.workerOnline
  if (workerOnline == null) {
    if (cfg.serverBrowserEnabled && cfg.serverBrowserPrimary) {
      workerOnline = true
    } else {
      const { countOnlineWorkers } = await import("./extensionWorkerRegistry")
      const online = await countOnlineWorkers(input.workspaceId)
      workerOnline = online > 0
    }
  }
  const result = await enqueueVerificationTask({
    globalAsinId: input.globalAsinId,
    workspaceId: input.workspaceId,
    preferredUserId: input.preferredUserId,
    catalogStateId: input.catalogStateId,
    asin: input.asin,
    amazonUrl: input.amazonUrl,
    reason: decision.reason,
    workerOnline,
  })
  return {
    created: result.created,
    taskId: result.taskId,
    code: decision.code,
    status: result.status,
    duplicate: !result.created,
  }
}

const QUEUED_VERIFICATION_STATUSES = ["PENDING", "WAITING_FOR_WORKER", "RETRYABLE"] as const

/**
 * Cancel queued/waiting tasks that are safe to drop. CLAIMED/RUNNING stay
 * (browser may finish) and must be discarded at apply time by the stale guard.
 */
export async function obsoleteQueuedVerificationTasks(input: {
  workspaceId: string
  catalogStateIds?: number[]
  ebayItemIds?: string[]
  keepAsin?: string | null
  reason?: string
  client?: PoolClient
}): Promise<number> {
  const catalogIds = (input.catalogStateIds ?? []).filter(id => Number.isFinite(id) && id > 0)
  const ebayIds = (input.ebayItemIds ?? []).map(id => String(id).trim()).filter(Boolean)
  if (catalogIds.length === 0 && ebayIds.length === 0) return 0
  const keepAsin = input.keepAsin?.trim().toUpperCase() || null
  const reason = (input.reason ?? "STALE_SOURCE_RESULT").slice(0, 200)
  const sql = `UPDATE amazon_price_verification_tasks t
     SET status = 'CANCELLED',
         failure_code = 'STALE_SOURCE_RESULT',
         failure_message = $4::text,
         completed_at = COALESCE(completed_at, NOW()),
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE t.workspace_id = $1::uuid
       AND t.status = ANY($5::text[])
       AND ($3::text IS NULL OR t.asin <> $3::text)
       AND t.catalog_state_id IN (
         SELECT scs.id
         FROM store_catalog_state scs
         WHERE scs.workspace_id = $1::uuid
           AND (
             (cardinality($2::bigint[]) > 0 AND scs.id = ANY($2::bigint[]))
             OR (cardinality($6::text[]) > 0 AND trim(scs.ebay_item_id) = ANY($6::text[]))
           )
       )`
  const params = [
    input.workspaceId,
    catalogIds,
    keepAsin,
    reason,
    [...QUEUED_VERIFICATION_STATUSES],
    ebayIds,
  ]
  const res = input.client
    ? await input.client.query(sql, params)
    : await query(sql, params)
  return res.rowCount ?? 0
}
