// ----------------------------------------------------------------
// extensionCaptureService.ts — persistent extension bulk capture jobs
// ----------------------------------------------------------------

import { db, query } from "../../db/client"
import { extractAndSaveProduct } from "../productExtractor/productExtractorService"
import type { ProductExtractorRequest } from "../productExtractor/productExtractorTypes"
import { normalizePoolId } from "../pool/poolEligibilityService"
import {
  evaluatePoolAmazonAvailability,
  resolveDirectListAvailabilitySkipReason,
  resolveAvailabilitySkipReason,
} from "../amazon/amazonAvailabilityGuardService"
import { finalizeCommandProgress } from "../scheduledPublish/scheduledPublishService"
import { summarizeExtensionCaptureOutcome } from "./extensionCaptureOutcome"
import { parsePromotedRequest } from "../ebay/ebayPromotedTypes"
import { applyListingPromotion } from "../ebay/ebayPromotedAdService"
import type { PromotionPublic } from "../ebay/ebayPromotedTypes"
import type {
  ClaimNextCaptureResponse,
  CreateExtensionCaptureRequest,
  CreateExtensionCaptureResponse,
  ExtensionCaptureCommandDetail,
  ExtensionCaptureItemStatus,
  ExtensionCaptureItemSummary,
  ExtensionCaptureOperationType,
  FailCaptureItemResponse,
  SubmitCapturePayloadResponse,
} from "./extensionCaptureTypes"

const ASIN_REGEX = /^[A-Z0-9]{10}$/
const ACTIVE_COMMAND_STATUSES = ["queued", "capturing", "captured", "publishing"] as const
const CLAIMABLE_COMMAND_STATUSES = ["queued", "capturing", "publishing"] as const
const LEASE_MINUTES = 5
const MAX_CAPTURE_ATTEMPTS = 3

type CommandRow = {
  id: number
  workspace_id: string
  store_code: string
  operation_type: string
  title_mode: string
  quantity: number
  delay_sec: number
  status: string
  total_count: number
  captured_count: number
  failed_count: number
  published_count: number
  added_count: number
  skipped_count: number
  publish_command_id: number | null
  publish_job_seq: number
  metadata: unknown
  created_at: string
  updated_at: string
  completed_at: string | null
  promoted_enabled?: boolean
  promoted_ad_rate?: string | null
}

type ItemRow = {
  id: number
  command_id: number
  asin: string
  amazon_url: string
  status: string
  pool_id: number | null
  scheduled_publish_job_id: number | null
  error_message: string | null
  listing_id?: string | null
}

function normalizeAsin(raw: string): string | null {
  const asin = raw.trim().toUpperCase()
  return ASIN_REGEX.test(asin) ? asin : null
}

function amazonUrlForAsin(asin: string): string {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}`
}

function mapItem(row: ItemRow): ExtensionCaptureItemSummary {
  const listingId = row.listing_id?.trim() || null
  const outcome = summarizeExtensionCaptureOutcome({
    itemStatus:   row.status,
    errorMessage: row.error_message,
    listingId,
  })
  return {
    itemId:        row.id,
    asin:          row.asin,
    amazonUrl:     row.amazon_url,
    status:        row.status as ExtensionCaptureItemStatus,
    poolId:        row.pool_id != null ? normalizePoolId(row.pool_id) : null,
    errorMessage:  row.error_message,
    ok:            outcome.ok,
    code:          outcome.code,
    message:       outcome.message,
    retryable:     outcome.retryable,
    jobId:         row.scheduled_publish_job_id,
    listingId,
    alreadyExists: outcome.alreadyExists,
  }
}

async function loadCommand(
  workspaceId: string,
  commandId:   number
): Promise<CommandRow | null> {
  const result = await query<CommandRow>(
    `SELECT id, workspace_id::text AS workspace_id, store_code, operation_type,
            title_mode, quantity, delay_sec, status,
            total_count, captured_count, failed_count, published_count,
            added_count, skipped_count, publish_command_id, publish_job_seq,
            metadata, created_at::text, updated_at::text, completed_at::text,
            promoted_enabled, promoted_ad_rate::text
     FROM extension_capture_commands
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, commandId]
  )
  return result.rows[0] ?? null
}

async function loadItems(commandId: number): Promise<ItemRow[]> {
  const result = await query<ItemRow>(
    `SELECT i.id, i.command_id, i.asin, i.amazon_url, i.status, i.pool_id,
            i.scheduled_publish_job_id, i.error_message,
            NULLIF(trim(j.result->>'ebayItemId'), '') AS listing_id
     FROM extension_capture_items i
     LEFT JOIN scheduled_publish_jobs j ON j.id = i.scheduled_publish_job_id
     WHERE i.command_id = $1
     ORDER BY i.id ASC`,
    [commandId]
  )
  return result.rows
}

async function refreshCommandCounts(commandId: number): Promise<void> {
  await query(
    `UPDATE extension_capture_commands c
     SET
       captured_count = (
         SELECT COUNT(*) FROM extension_capture_items i
         WHERE i.command_id = c.id
           AND i.status IN ('captured', 'queued_for_publish', 'added_to_pool', 'published')
       ),
       failed_count = (
         SELECT COUNT(*) FROM extension_capture_items i
         WHERE i.command_id = c.id
           AND i.status IN ('extract_failed', 'failed', 'capture_blocked')
       ),
       published_count = (
         SELECT COUNT(*) FROM extension_capture_items i
         WHERE i.command_id = c.id AND i.status = 'published'
       ),
       added_count = (
         SELECT COUNT(*) FROM extension_capture_items i
         WHERE i.command_id = c.id AND i.status = 'added_to_pool'
       ),
       skipped_count = (
         SELECT COUNT(*) FROM extension_capture_items i
         WHERE i.command_id = c.id
           AND i.status LIKE 'skipped_%'
       ),
       updated_at = NOW()
     WHERE c.id = $1`,
    [commandId]
  )

  const pending = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM extension_capture_items
     WHERE command_id = $1 AND status IN ('capture_pending', 'capturing')`,
    [commandId]
  )
  const pendingCount = parseInt(pending.rows[0]?.cnt ?? "0", 10)

  const queuedPublish = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM extension_capture_items
     WHERE command_id = $1 AND status = 'queued_for_publish'`,
    [commandId]
  )
  const queuedPublishCount = parseInt(queuedPublish.rows[0]?.cnt ?? "0", 10)

  const cmd = await query<{ operation_type: string; publish_command_id: number | null }>(
    `SELECT operation_type, publish_command_id FROM extension_capture_commands WHERE id = $1`,
    [commandId]
  )
  const row = cmd.rows[0]
  if (!row) return

  if (pendingCount === 0) {
    if (row.operation_type === "bulk_direct_list") {
      if (queuedPublishCount > 0) {
        await query(
          `UPDATE extension_capture_commands
           SET status = 'publishing',
               completed_at = NULL,
               updated_at = NOW()
           WHERE id = $1 AND status NOT IN ('cancelled', 'failed', 'completed')`,
          [commandId]
        )
      } else if (row.publish_command_id != null) {
        // Capture finished and every publish-linked item left queued_for_publish.
        await query(
          `UPDATE extension_capture_commands
           SET status = 'completed',
               completed_at = COALESCE(completed_at, NOW()),
               updated_at = NOW()
           WHERE id = $1 AND status NOT IN ('cancelled', 'failed')`,
          [commandId]
        )
      } else {
        await query(
          `UPDATE extension_capture_commands
           SET status = 'captured',
               completed_at = NOW(),
               updated_at = NOW()
           WHERE id = $1 AND status NOT IN ('cancelled', 'failed', 'completed')`,
          [commandId]
        )
      }
    } else {
      await query(
        `UPDATE extension_capture_commands
         SET status = 'completed', completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status NOT IN ('cancelled', 'failed')`,
        [commandId]
      )
    }
  } else {
    await query(
      `UPDATE extension_capture_commands
       SET status = 'capturing', updated_at = NOW()
       WHERE id = $1 AND status IN ('queued', 'captured', 'publishing')`,
      [commandId]
    )
  }
}

/**
 * Propagate scheduled-publish job terminal outcome onto linked extension capture item/command.
 * No schema change — status + completed_at only.
 */
export async function finalizeExtensionCaptureForPublishJob(input: {
  workspaceId: string
  publishJobId: number
  outcome: "published" | "failed" | "skipped" | "blocked"
  errorMessage?: string | null
}): Promise<void> {
  const publishJobId = Number(input.publishJobId)
  if (!Number.isInteger(publishJobId) || publishJobId <= 0) return

  const itemStatus =
    input.outcome === "published"
      ? "published"
      : input.outcome === "skipped"
        ? "skipped_duplicate"
        : "failed"
  const errorMessage =
    input.outcome === "published"
      ? null
      : String(input.errorMessage ?? input.outcome).slice(0, 500)

  const updated = await query<{ id: number; command_id: number }>(
    `UPDATE extension_capture_items
     SET status = $3,
         error_message = $4,
         completed_at = COALESCE(completed_at, NOW()),
         updated_at = NOW()
     WHERE workspace_id = $1
       AND scheduled_publish_job_id = $2
       AND status IN ('queued_for_publish', 'captured', 'capturing', 'capture_pending')
     RETURNING id, command_id`,
    [input.workspaceId, publishJobId, itemStatus, errorMessage]
  )

  const commandIds = [...new Set(updated.rows.map((r) => Number(r.command_id)).filter((n) => n > 0))]
  for (const commandId of commandIds) {
    await refreshCommandCounts(commandId)
  }

  if (updated.rows.length > 0) {
    console.log("[ExtensionCapture] publish_outcome_propagated", {
      publishJobId,
      outcome: input.outcome,
      itemIds: updated.rows.map((r) => r.id),
      commandIds,
    })
  }
}

async function findStore(workspaceId: string, storeCode: string, storeId?: number) {
  if (storeId != null && Number.isInteger(storeId) && storeId > 0) {
    const byId = await query<{ id: number; store_code: string; status: string }>(
      `SELECT id, store_code, status FROM stores
       WHERE workspace_id = $1 AND id = $2
       LIMIT 1`,
      [workspaceId, storeId]
    )
    return byId.rows[0] ?? null
  }
  const result = await query<{ id: number; store_code: string; status: string }>(
    `SELECT id, store_code, status FROM stores
     WHERE workspace_id = $1 AND store_code = $2
     ORDER BY id ASC`,
    [workspaceId, storeCode]
  )
  if (result.rows.length > 1) {
    throw new Error("Ambiguous storeCode; use storeId")
  }
  return result.rows[0] ?? null
}

function toExtractorRequest(payload: Record<string, unknown>): ProductExtractorRequest {
  const asin = String(payload.asin ?? "").trim().toUpperCase()
  const primeStatusRaw = typeof payload.primeStatus === "string" ? payload.primeStatus.trim().toUpperCase() : ""
  const primeStatus =
    primeStatusRaw === "PRIME" || primeStatusRaw === "NOT_PRIME" || primeStatusRaw === "UNKNOWN"
      || primeStatusRaw === "PRIME_UNKNOWN"
      ? (primeStatusRaw === "PRIME_UNKNOWN" ? "UNKNOWN" : primeStatusRaw)
      : null
  const isPrime =
    payload.isPrime === true ? true
    : payload.isPrime === false ? false
    : null
  const selectedAsin = normalizeAsin(String(payload.selectedAsin ?? "")) || null
  const pageUrlAsin = normalizeAsin(String(payload.pageUrlAsin ?? "")) || null
  const stockStatusRaw = typeof payload.stockStatus === "string" ? payload.stockStatus.trim().toUpperCase() : ""
  const stockStatus =
    stockStatusRaw === "IN_STOCK" || stockStatusRaw === "LIMITED_STOCK" || stockStatusRaw === "OUT_OF_STOCK"
      || stockStatusRaw === "UNKNOWN" || stockStatusRaw === "STOCK_UNKNOWN"
      ? (stockStatusRaw === "STOCK_UNKNOWN" ? "UNKNOWN" : stockStatusRaw)
      : null
  const stockCount =
    typeof payload.stockCount === "number" && Number.isFinite(payload.stockCount)
      ? payload.stockCount
      : (typeof payload.stockCount === "string" && payload.stockCount.trim()
        ? Number(payload.stockCount) || null
        : null)
  return {
    asin,
    title:           String(payload.title ?? ""),
    brand:           String(payload.brand ?? ""),
    price:           Number(payload.price) || 0,
    currency:        String(payload.currency ?? "USD"),
    images:          Array.isArray(payload.images) ? payload.images.filter((x): x is string => typeof x === "string") : [],
    bullets:         Array.isArray(payload.bullets) ? payload.bullets.filter((x): x is string => typeof x === "string") : [],
    description:     String(payload.description ?? ""),
    specs:           (payload.specs && typeof payload.specs === "object" ? payload.specs : {}) as Record<string, string>,
    rating:          Number(payload.rating) || 0,
    reviews:         Number(payload.reviews) || 0,
    bsr:             payload.bsr != null ? Number(payload.bsr) : null,
    category:        String(payload.category ?? ""),
    isPrime,
    isFreeShipping:  payload.isFreeShipping === true,
    availabilityText: typeof payload.availabilityText === "string" ? payload.availabilityText : undefined,
    hasAddToCart:    typeof payload.hasAddToCart === "boolean" ? payload.hasAddToCart : undefined,
    hasBuyNow:       typeof payload.hasBuyNow === "boolean" ? payload.hasBuyNow : undefined,
    primeStatus,
    primeEvidence:   Array.isArray(payload.primeEvidence)
      ? payload.primeEvidence.filter((x): x is string => typeof x === "string")
      : undefined,
    primeCheckedAt:  typeof payload.primeCheckedAt === "string" ? payload.primeCheckedAt : undefined,
    selectedAsin,
    pageUrlAsin,
    stockStatus,
    stockCount,
    stockEvidence:   Array.isArray(payload.stockEvidence)
      ? payload.stockEvidence.filter((x): x is string => typeof x === "string")
      : undefined,
    stockCheckedAt:  typeof payload.stockCheckedAt === "string" ? payload.stockCheckedAt : undefined,
    source:          "extension",
    external_id:     typeof payload.amazonUrl === "string" ? payload.amazonUrl : amazonUrlForAsin(asin),
  }
}

async function appendLivePublishJob(
  workspaceId: string,
  command:     CommandRow,
  poolId:      number,
  asin:        string
): Promise<{ publishCommandId: number; publishJobId: number }> {
  const store = await findStore(workspaceId, command.store_code)
  if (!store) throw new Error("Store not found")
  if (store.status !== "active") throw new Error("Store is not active")

  const cmdMeta = command.metadata && typeof command.metadata === "object"
    ? command.metadata as Record<string, unknown>
    : {}

  const client = await db.connect()
  try {
    await client.query("BEGIN")

    let publishCommandId = command.publish_command_id
    const jobIndex = command.publish_job_seq

    if (!publishCommandId) {
      const scheduleStartAt = typeof cmdMeta.scheduleStartAt === "string"
        ? cmdMeta.scheduleStartAt
        : null
      const executionMode = cmdMeta.executionMode === "simulation" ? "simulation" : "live"
      const cmdTitle = typeof cmdMeta.scheduleTitle === "string"
        ? cmdMeta.scheduleTitle
        : `Extension capture #${command.id}`
      const metadata = {
        executionMode,
        source:                    "extension_capture",
        extensionCaptureCommandId: command.id,
        titleMode:                 command.title_mode,
        scheduleStartAt,
      }
      const cmdIns = await client.query<{ id: number }>(
        `INSERT INTO scheduled_publish_commands (
           workspace_id, store_id, store_code, title, selection_mode,
           requested_count, eligible_count, skipped_count, created_job_count,
           start_at, interval_seconds, quantity, title_mode, status,
           created_by, metadata
         ) VALUES (
           $1, $2, $3, $4, 'selected',
           1, 1, 0, 1,
           $5, $6, $7, $8, 'scheduled',
           'extension_capture', $9::jsonb
         )
         RETURNING id`,
        [
          workspaceId,
          store.id,
          command.store_code,
          cmdTitle,
          scheduleStartAt ?? new Date().toISOString(),
          command.delay_sec,
          command.quantity,
          command.title_mode,
          JSON.stringify(metadata),
        ]
      )
      publishCommandId = cmdIns.rows[0]?.id ?? null
      if (!publishCommandId) throw new Error("Failed to create publish command")

      await client.query(
        `UPDATE extension_capture_commands
         SET publish_command_id = $2, status = 'publishing', updated_at = NOW()
         WHERE id = $1`,
        [command.id, publishCommandId]
      )
    }

    const dup = await client.query<{ id: number }>(
      `SELECT id FROM scheduled_publish_jobs
       WHERE command_id = $1 AND pool_id = $2
         AND status NOT IN ('cancelled', 'failed')
       LIMIT 1`,
      [publishCommandId, poolId]
    )
    if (dup.rows[0]?.id) {
      await client.query("COMMIT")
      return { publishCommandId: publishCommandId!, publishJobId: dup.rows[0].id }
    }

    const baseStart = await client.query<{ start_at: string }>(
      `SELECT start_at::text FROM scheduled_publish_commands WHERE id = $1`,
      [publishCommandId]
    )
    const startMs = new Date(baseStart.rows[0]?.start_at ?? new Date().toISOString()).getTime()
    const scheduledAt = new Date(startMs + jobIndex * command.delay_sec * 1000).toISOString()

    const jobIns = await client.query<{ id: number }>(
      `INSERT INTO scheduled_publish_jobs (
         workspace_id, command_id, store_id, store_code,
         pool_id, asin, scheduled_at, status, promoted_enabled, promoted_ad_rate
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, 'scheduled', $8, $9)
       RETURNING id`,
      [
        workspaceId,
        publishCommandId,
        store.id,
        command.store_code,
        poolId,
        asin,
        scheduledAt,
        command.promoted_enabled === true,
        command.promoted_ad_rate != null ? Number(command.promoted_ad_rate) : null,
      ]
    )
    const publishJobId = jobIns.rows[0]?.id
    if (!publishJobId) throw new Error("Failed to create publish job")

    await client.query(
      `UPDATE extension_capture_commands
       SET publish_job_seq = publish_job_seq + 1, updated_at = NOW()
       WHERE id = $1`,
      [command.id]
    )

    await client.query(
      `UPDATE scheduled_publish_commands
       SET created_job_count = created_job_count + 1,
           eligible_count = eligible_count + 1,
           requested_count = GREATEST(requested_count, created_job_count + 1),
           updated_at = NOW()
       WHERE id = $1`,
      [publishCommandId]
    )

    await client.query("COMMIT")

    await finalizeCommandProgress(workspaceId, publishCommandId!)

    console.log("[ExtensionCapture] publish_job_appended", {
      captureCommandId: command.id,
      publishCommandId,
      publishJobId,
      poolId,
      asin,
      scheduledAt,
    })

    // Soft-wake existing live runner (no second publisher).
    // If scheduled_at is in the future, delay the wake so Listing Delay is respected.
    try {
      const dueInMs = Math.max(0, new Date(scheduledAt).getTime() - Date.now())
      const { wakeScheduledPublishLiveRunner } = await import(
        "../scheduledPublish/scheduledPublishLiveAutoRunnerService"
      )
      wakeScheduledPublishLiveRunner(dueInMs)
    } catch (e) {
      console.warn(
        "[ExtensionCapture] publish runner wake failed:",
        e instanceof Error ? e.message : String(e)
      )
    }

    return { publishCommandId: publishCommandId!, publishJobId }
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

/**
 * A prior Direct List availability failure may have soft-archived the shared
 * pool row. Re-open only that narrow, definitely-unpublished retry case.
 * Historical/import/high-risk archives and active or published references stay
 * untouched.
 */
async function reactivateFailedDirectListAvailabilityPool(
  workspaceId: string,
  poolId:      number,
  asin:        string
): Promise<boolean> {
  const result = await query<{ id: number }>(
    `UPDATE asin_pool ap
     SET archived_at       = NULL,
         archived_by       = NULL,
         archive_reason    = NULL,
         status            = 'ready',
         pipeline_stage    = 'validated',
         scrape_status     = 'pending',
         ai_status         = 'pending',
         listing_status    = 'pending',
         assigned_store_id = NULL,
         skip_reason       = NULL,
         updated_at        = NOW()
     WHERE ap.workspace_id = $1
       AND ap.id = $2
       AND ap.archived_at IS NOT NULL
       AND ap.archive_reason IN (
         'NOT_PRIME_SKIPPED', 'OUT_OF_STOCK_SKIPPED',
         'LIMITED_STOCK_SKIPPED', 'STOCK_UNKNOWN_SKIPPED',
         'PRIME_UNKNOWN_SKIPPED'
       )
       AND ap.status <> 'completed'
       AND ap.pipeline_stage <> 'listed'
       AND ap.listing_status <> 'success'
       AND EXISTS (
         SELECT 1
         FROM extension_capture_items eci
         INNER JOIN extension_capture_commands ecc ON ecc.id = eci.command_id
         LEFT JOIN scheduled_publish_jobs spj ON spj.id = eci.scheduled_publish_job_id
         WHERE eci.workspace_id = ap.workspace_id
           AND eci.pool_id = ap.id
           AND eci.asin = $3
           AND ecc.operation_type = 'bulk_direct_list'
           AND eci.status IN ('failed', 'capture_blocked')
           AND COALESCE(spj.status, '') NOT IN ('published')
           AND COALESCE(spj.result->>'published', 'false') <> 'true'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM scheduled_publish_jobs active_job
         INNER JOIN scheduled_publish_commands active_cmd
           ON active_cmd.id = active_job.command_id
         WHERE active_job.workspace_id = ap.workspace_id
           AND active_job.pool_id = ap.id
           AND active_job.status IN ('scheduled', 'running')
           AND active_cmd.status IN ('scheduled', 'running', 'paused')
       )
       AND NOT EXISTS (
         SELECT 1
         FROM listing_history lh
         WHERE lh.workspace_id = ap.workspace_id
           AND lh.asin_registry_id = ap.asin_registry_id
           AND lh.status = 'live'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM store_catalog_state scs
         WHERE scs.workspace_id = ap.workspace_id
           AND scs.asin_registry_id = ap.asin_registry_id
           AND scs.current_status = 'live'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM scheduled_publish_jobs published_job
         WHERE published_job.workspace_id = ap.workspace_id
           AND published_job.pool_id = ap.id
           AND (
             published_job.status = 'published'
             OR published_job.result->>'published' = 'true'
           )
       )
     RETURNING ap.id`,
    [workspaceId, poolId, asin]
  )
  return result.rows.length > 0
}

function resolveCaptureInputs(
  req: CreateExtensionCaptureRequest
): Array<{ asin: string; poolId: number | null }> {
  const seenAsins = new Set<string>()
  const seenPoolIds = new Set<number>()
  const out: Array<{ asin: string; poolId: number | null }> = []

  const push = (asinRaw: string, poolIdRaw?: number) => {
    const asin = normalizeAsin(asinRaw)
    if (!asin || seenAsins.has(asin)) return
    const poolId = poolIdRaw != null ? normalizePoolId(poolIdRaw) : null
    if (poolId != null && seenPoolIds.has(poolId)) return
    seenAsins.add(asin)
    if (poolId != null) seenPoolIds.add(poolId)
    out.push({ asin, poolId })
  }

  if (req.items?.length) {
    for (const item of req.items) push(item.asin, item.poolId)
  } else {
    for (const asin of req.asins ?? []) push(asin)
  }

  return out
}

export async function createExtensionCaptureCommand(
  workspaceId: string,
  req:         CreateExtensionCaptureRequest
): Promise<CreateExtensionCaptureResponse> {
  const storeCode = String(req.storeCode ?? "").trim()
  if (!storeCode && !(req.storeId != null && Number.isInteger(req.storeId) && req.storeId > 0)) {
    throw new Error("storeCode is required")
  }

  const store = await findStore(workspaceId, storeCode, req.storeId)
  if (!store) throw new Error("Store not found")
  const resolvedStoreCode = store.store_code

  const operationType = req.operationType
  if (operationType !== "bulk_direct_list" && operationType !== "bulk_add_to_pool") {
    throw new Error("operationType must be bulk_direct_list or bulk_add_to_pool")
  }

  const inputs = resolveCaptureInputs(req)
  if (inputs.length === 0) throw new Error("asins must contain at least one valid ASIN")

  const titleMode = req.titleMode?.trim() || "titlebot"
  const quantity = Number.isInteger(req.quantity) && (req.quantity ?? 0) >= 1 ? req.quantity! : 1
  const delaySec = Number.isInteger(req.delaySec) && (req.delaySec ?? 0) >= 1 ? req.delaySec! : 30
  const publishCommandId = req.publishCommandId != null && req.publishCommandId >= 1
    ? req.publishCommandId
    : null
  const publishJobSeq = Number.isInteger(req.publishJobSeq) && (req.publishJobSeq ?? 0) >= 0
    ? req.publishJobSeq!
    : 0
  const metadata = req.metadata && typeof req.metadata === "object" ? req.metadata : {}
  const promo = parsePromotedRequest({
    promotedEnabled: req.promotedEnabled ?? (metadata as { promotedEnabled?: unknown }).promotedEnabled,
    promotedAdRate: req.promotedAdRate ?? (metadata as { promotedAdRate?: unknown }).promotedAdRate,
  })
  if (!promo.ok) throw new Error(promo.message)
  const promotedEnabled = promo.enabled
  const promotedAdRate = promo.enabled ? promo.rate : null

  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const cmdResult = await client.query<{ id: number }>(
      `INSERT INTO extension_capture_commands (
         workspace_id, store_code, operation_type, title_mode, quantity, delay_sec,
         status, total_count, publish_command_id, publish_job_seq, metadata,
         promoted_enabled, promoted_ad_rate
       ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10::jsonb, $11, $12)
       RETURNING id`,
      [
        workspaceId,
        resolvedStoreCode,
        operationType,
        titleMode,
        quantity,
        delaySec,
        inputs.length,
        publishCommandId,
        publishJobSeq,
        JSON.stringify({ ...metadata, promotedEnabled, promotedAdRate }),
        promotedEnabled,
        promotedAdRate,
      ]
    )
    const commandId = cmdResult.rows[0]?.id
    if (!commandId) throw new Error("Failed to create capture command")

    if (publishCommandId) {
      await client.query(
        `UPDATE extension_capture_commands
         SET status = 'publishing', updated_at = NOW()
         WHERE id = $1`,
        [commandId]
      )
    }

    const items: ExtensionCaptureItemSummary[] = []
    for (const input of inputs) {
      const ins = await client.query<ItemRow>(
        `INSERT INTO extension_capture_items (
           command_id, workspace_id, asin, amazon_url, status, pool_id
         ) VALUES ($1, $2, $3, $4, 'capture_pending', $5)
         RETURNING id, command_id, asin, amazon_url, status, pool_id,
                   scheduled_publish_job_id, error_message`,
        [commandId, workspaceId, input.asin, amazonUrlForAsin(input.asin), input.poolId]
      )
      const row = ins.rows[0]
      if (row) items.push(mapItem(row))
    }

    await client.query("COMMIT")

    console.log("[ExtensionCapture] created", {
      commandId,
      operationType,
      storeCode: resolvedStoreCode,
      itemCount: items.length,
      titleMode,
      delaySec,
      publishCommandId,
      publishJobSeq,
    })

    return { ok: true, commandId, items }
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

export async function getExtensionCaptureCommand(
  workspaceId: string,
  commandId:   number
): Promise<ExtensionCaptureCommandDetail | null> {
  const cmd = await loadCommand(workspaceId, commandId)
  if (!cmd) return null
  const items = await loadItems(commandId)
  const meta = cmd.metadata && typeof cmd.metadata === "object"
    ? cmd.metadata as Record<string, unknown>
    : {}

  const mapped = items.map(mapItem)
  const listingIds = mapped.map(i => i.listingId).filter((x): x is string => !!x)
  const promoByListing = new Map<string, PromotionPublic>()
  if (listingIds.length > 0) {
    const store = await findStore(workspaceId, cmd.store_code)
    if (store) {
      const promoRes = await query<{
        ebay_listing_id: string
        requested: boolean
        requested_rate: string | null
        effective_rate: string | null
        campaign_id: string | null
        ad_id: string | null
        status: string
        last_error_code: string | null
      }>(
        `SELECT ebay_listing_id, requested, requested_rate::text, effective_rate::text,
                campaign_id, ad_id, status, last_error_code
         FROM ebay_listing_promotions
         WHERE workspace_id = $1::uuid AND store_id = $2 AND ebay_listing_id = ANY($3::text[])`,
        [workspaceId, store.id, listingIds]
      )
      const { toPromotionPublic } = await import("../ebay/ebayPromotedTypes")
      for (const r of promoRes.rows) {
        promoByListing.set(r.ebay_listing_id, toPromotionPublic({
          requested: r.requested,
          requestedRate: r.requested_rate != null ? Number(r.requested_rate) : null,
          status: r.status as "OFF" | "PENDING" | "ACTIVE" | "FAILED" | "UNKNOWN",
          effectiveRate: r.effective_rate != null ? Number(r.effective_rate) : null,
          campaignId: r.campaign_id,
          adId: r.ad_id,
          lastErrorCode: r.last_error_code,
        }))
      }
    }
  }

  return {
    id:               cmd.id,
    storeCode:        cmd.store_code,
    operationType:    cmd.operation_type as ExtensionCaptureOperationType,
    titleMode:        cmd.title_mode,
    quantity:         cmd.quantity,
    delaySec:         cmd.delay_sec,
    status:           cmd.status as ExtensionCaptureCommandDetail["status"],
    totalCount:       cmd.total_count,
    capturedCount:    cmd.captured_count,
    failedCount:      cmd.failed_count,
    publishedCount:   cmd.published_count,
    addedCount:       cmd.added_count,
    skippedCount:     cmd.skipped_count,
    publishCommandId: cmd.publish_command_id,
    metadata:         meta,
    createdAt:        cmd.created_at,
    updatedAt:        cmd.updated_at,
    completedAt:      cmd.completed_at,
    items:            mapped.map(item => ({
      ...item,
      promotion: item.listingId ? (promoByListing.get(item.listingId) ?? null) : null,
    })),
  }
}

export async function listActiveExtensionCaptureCommands(
  workspaceId: string
): Promise<ExtensionCaptureCommandDetail[]> {
  const result = await query<{ id: number }>(
    `SELECT id FROM extension_capture_commands
     WHERE workspace_id = $1 AND status = ANY($2::text[])
     ORDER BY updated_at DESC
     LIMIT 10`,
    [workspaceId, [...ACTIVE_COMMAND_STATUSES]]
  )
  const out: ExtensionCaptureCommandDetail[] = []
  for (const row of result.rows) {
    const detail = await getExtensionCaptureCommand(workspaceId, row.id)
    if (detail) out.push(detail)
  }
  return out
}

export async function claimNextCaptureItem(
  workspaceId: string,
  workerId:    string
): Promise<ClaimNextCaptureResponse> {
  const wId = workerId.trim()
  if (!wId) throw new Error("workerId is required")

  const client = await db.connect()
  try {
    await client.query("BEGIN")

    await client.query(
      `UPDATE extension_capture_items
       SET status = 'extract_failed',
           error_message = 'MAX_CAPTURE_ATTEMPTS_EXCEEDED',
           worker_id = NULL,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1
         AND status IN ('capture_pending', 'capturing')
         AND capture_attempts >= $2`,
      [workspaceId, MAX_CAPTURE_ATTEMPTS]
    )

    await client.query(
      `UPDATE extension_capture_items
       SET status = CASE
             WHEN capture_attempts >= $2 THEN 'extract_failed'
             ELSE 'capture_pending'
           END,
           error_message = CASE
             WHEN capture_attempts >= $2 THEN 'MAX_CAPTURE_ATTEMPTS_EXCEEDED'
             ELSE error_message
           END,
           worker_id = NULL,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE status = 'capturing'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < NOW()
         AND workspace_id = $1`,
      [workspaceId, MAX_CAPTURE_ATTEMPTS]
    )

    const claim = await client.query<{
      item_id: number
      command_id: number
      asin: string
      amazon_url: string
      pool_id: number | null
    }>(
      `WITH candidate AS (
         SELECT i.id AS item_id, i.command_id
         FROM extension_capture_items i
         INNER JOIN extension_capture_commands c ON c.id = i.command_id
         WHERE c.workspace_id = $1
           AND c.status = ANY($2::text[])
           AND i.capture_attempts < $5
           AND (
             i.status = 'capture_pending'
             OR (
               i.status = 'capturing'
               AND (i.lease_expires_at IS NULL OR i.lease_expires_at < NOW())
             )
           )
         ORDER BY c.created_at ASC, i.id ASC
         LIMIT 1
         FOR UPDATE OF i SKIP LOCKED
       )
       UPDATE extension_capture_items i
       SET status = 'capturing',
           worker_id = $3,
           lease_expires_at = NOW() + ($4::int * interval '1 minute'),
           capture_attempts = capture_attempts + 1,
           last_capture_started_at = NOW(),
           updated_at = NOW()
       FROM candidate cand
       WHERE i.id = cand.item_id
       RETURNING i.id AS item_id, i.command_id, i.asin, i.amazon_url, i.pool_id`,
      [workspaceId, [...CLAIMABLE_COMMAND_STATUSES], wId, LEASE_MINUTES, MAX_CAPTURE_ATTEMPTS]
    )

    const row = claim.rows[0]
    if (!row) {
      await client.query("COMMIT")
      return { ok: true, message: "No pending capture items" }
    }

    const cmd = await client.query<{
      store_code: string
      operation_type: string
      title_mode: string
      quantity: number
      delay_sec: number
    }>(
      `SELECT store_code, operation_type, title_mode, quantity, delay_sec
       FROM extension_capture_commands
       WHERE id = $1 AND workspace_id = $2`,
      [row.command_id, workspaceId]
    )

    await client.query(
      `UPDATE extension_capture_commands
       SET status = 'capturing', updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2`,
      [row.command_id, workspaceId]
    )

    await client.query("COMMIT")

    const c = cmd.rows[0]
    if (!c) return { ok: true, message: "Command not found after claim" }

    console.log("[ExtensionCapture] item_claimed", {
      commandId: row.command_id,
      itemId:    row.item_id,
      asin:      row.asin,
      workerId:  wId,
    })

    return {
      ok: true,
      message: "Item claimed",
      item: {
        commandId:     row.command_id,
        itemId:        row.item_id,
        asin:          row.asin,
        amazonUrl:     row.amazon_url,
        operationType: c.operation_type as ExtensionCaptureOperationType,
        storeCode:     c.store_code,
        titleMode:     c.title_mode,
        quantity:      c.quantity,
        delaySec:      c.delay_sec,
        poolId:        row.pool_id != null ? normalizePoolId(row.pool_id) : null,
      },
    }
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

const TERMINAL_BLOCK_CODES = new Set([
  "SIGNIN_REQUIRED",
  "PAGE_UNAVAILABLE",
  "ASIN_MISMATCH",
])

export async function failExtensionCaptureItem(
  workspaceId: string,
  commandId:   number,
  itemId:      number,
  opts:        { errorCode?: string; errorMessage: string; retryable?: boolean }
): Promise<FailCaptureItemResponse> {
  const rawMsg = opts.errorMessage.trim()
  if (!rawMsg) throw new Error("errorMessage is required")

  const errorCode = opts.errorCode?.trim() || "UNKNOWN_CAPTURE_ERROR"
  const formatted = `${errorCode}: ${rawMsg}`.slice(0, 500)

  const itemResult = await query<{ capture_attempts: number; status: string }>(
    `SELECT capture_attempts, status FROM extension_capture_items
     WHERE id = $1 AND command_id = $2 AND workspace_id = $3`,
    [itemId, commandId, workspaceId]
  )
  const item = itemResult.rows[0]
  if (!item) throw new Error("Capture item not found")

  const terminal = new Set(["captured", "queued_for_publish", "added_to_pool", "published", "extract_failed", "capture_blocked"])
  if (terminal.has(item.status)) {
    return { ok: true, itemId, status: item.status as ExtensionCaptureItemStatus }
  }

  const retryable = opts.retryable === true && item.capture_attempts < MAX_CAPTURE_ATTEMPTS

  let nextStatus: ExtensionCaptureItemStatus
  if (retryable) {
    nextStatus = "capture_pending"
  } else if (TERMINAL_BLOCK_CODES.has(errorCode)) {
    nextStatus = "capture_blocked"
  } else {
    nextStatus = "extract_failed"
  }

  await query(
    `UPDATE extension_capture_items
     SET status = $4,
         error_message = $5,
         worker_id = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $1 AND command_id = $2 AND workspace_id = $3`,
    [itemId, commandId, workspaceId, nextStatus, formatted]
  )

  await refreshCommandCounts(commandId)

  console.log("[ExtensionCapture] item_failed", {
    commandId,
    itemId,
    nextStatus,
    retryable,
    errorCode,
    errorMessage: formatted,
    captureAttempts: item.capture_attempts,
  })

  return { ok: true, itemId, status: nextStatus }
}

export async function startExtensionCaptureItem(
  workspaceId: string,
  commandId:   number,
  itemId:      number
): Promise<ExtensionCaptureItemSummary | null> {
  const result = await query<ItemRow>(
    `UPDATE extension_capture_items i
     SET status = 'capturing', updated_at = NOW()
     FROM extension_capture_commands c
     WHERE i.id = $3 AND i.command_id = $2 AND c.id = i.command_id
       AND c.workspace_id = $1
       AND i.status = 'capture_pending'
       AND c.status NOT IN ('cancelled', 'completed', 'failed')
     RETURNING i.id, i.command_id, i.asin, i.amazon_url, i.status, i.pool_id,
               i.scheduled_publish_job_id, i.error_message`,
    [workspaceId, commandId, itemId]
  )
  const row = result.rows[0]
  if (!row) return null

  await query(
    `UPDATE extension_capture_commands SET status = 'capturing', updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2`,
    [commandId, workspaceId]
  )

  return mapItem(row)
}

export async function submitExtensionCaptureItem(
  workspaceId: string,
  commandId:   number,
  itemId:      number,
  payload:     Record<string, unknown>
): Promise<SubmitCapturePayloadResponse> {
  const cmd = await loadCommand(workspaceId, commandId)
  if (!cmd) throw new Error("Capture command not found")
  if (cmd.status === "cancelled") throw new Error("Capture command cancelled")

  const itemResult = await query<ItemRow & { capture_payload: unknown }>(
    `SELECT id, command_id, asin, amazon_url, status, pool_id,
            scheduled_publish_job_id, error_message, capture_payload
     FROM extension_capture_items
     WHERE id = $1 AND command_id = $2 AND workspace_id = $3`,
    [itemId, commandId, workspaceId]
  )
  const item = itemResult.rows[0]
  if (!item) throw new Error("Capture item not found")

  const terminalOk = new Set([
    "captured", "queued_for_publish", "added_to_pool", "published",
  ])
  if (terminalOk.has(item.status)) {
    return {
      ok:               true,
      itemId:           item.id,
      asin:             item.asin,
      status:           item.status as ExtensionCaptureItemStatus,
      poolId:           item.pool_id != null ? normalizePoolId(item.pool_id) : null,
      publishCommandId: cmd.publish_command_id,
      publishJobId:     item.scheduled_publish_job_id,
      alreadyCaptured:  true,
    }
  }

  const payloadAsin = normalizeAsin(String(payload.asin ?? ""))
  if (!payloadAsin || payloadAsin !== item.asin) {
    throw new Error("capturePayload.asin must match item ASIN")
  }

  const selectedAsin = normalizeAsin(String(payload.selectedAsin ?? "")) || payloadAsin
  const pageUrlAsin = normalizeAsin(String(payload.pageUrlAsin ?? "")) || null
  console.log("[ExtensionCapture] prime_payload", {
    expectedAsin: item.asin,
    payloadAsin,
    selectedAsin,
    pageUrlAsin,
    primeStatus: typeof payload.primeStatus === "string" ? payload.primeStatus : null,
    isPrime: payload.isPrime === true ? true : payload.isPrime === false ? false : null,
    primeEvidence: Array.isArray(payload.primeEvidence) ? payload.primeEvidence.slice(0, 8) : null,
    primeCheckedAt: typeof payload.primeCheckedAt === "string" ? payload.primeCheckedAt : null,
  })
  console.log("[ExtensionCapture] stock_payload", {
    asin: item.asin,
    selectedAsin,
    stockStatus: typeof payload.stockStatus === "string" ? payload.stockStatus : null,
    stockCount: payload.stockCount ?? null,
    stockEvidence: Array.isArray(payload.stockEvidence) ? payload.stockEvidence.slice(0, 8) : null,
  })

  if (
    (selectedAsin && selectedAsin !== item.asin)
    || (pageUrlAsin && pageUrlAsin !== item.asin)
  ) {
    const mismatchMsg = "ASIN_MISMATCH: selectedAsin/pageUrlAsin does not match job expectedAsin"
    await query(
      `UPDATE extension_capture_items
       SET status = 'capture_blocked',
           error_message = $2,
           capture_payload = $3::jsonb,
           captured_at = NOW(),
           completed_at = NOW(),
           worker_id = NULL,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [itemId, mismatchMsg.slice(0, 500), JSON.stringify(payload)]
    )
    await refreshCommandCounts(commandId)
    console.log("[ExtensionCapture] asin_mismatch", {
      commandId, itemId, expectedAsin: item.asin, payloadAsin, selectedAsin, pageUrlAsin,
    })
    return {
      ok: true,
      itemId,
      asin: item.asin,
      status: "capture_blocked",
      poolId: item.pool_id != null ? normalizePoolId(item.pool_id) : null,
      publishCommandId: null,
      publishJobId: null,
      alreadyCaptured: false,
    }
  }

  if (payload.captureBlocked === true) {
    const blockReason = typeof payload.blockReason === "string"
      ? payload.blockReason
      : "CAPTURE_BLOCKED"
    const retryable = blockReason === "CAPTCHA" || blockReason === "ROBOT_CHECK"
    if (retryable) {
      await failExtensionCaptureItem(workspaceId, commandId, itemId, {
        errorMessage: blockReason,
        retryable:    true,
      })
    } else {
      await query(
        `UPDATE extension_capture_items
         SET status = 'capture_blocked',
             error_message = $2,
             worker_id = NULL,
             lease_expires_at = NULL,
             capture_payload = $3::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [itemId, blockReason.slice(0, 500), JSON.stringify(payload)]
      )
      await refreshCommandCounts(commandId)
    }
    throw new Error(`Capture blocked: ${blockReason}`)
  }

  const enrichedPayload = {
    ...payload,
    asin:       item.asin,
    amazonUrl:  item.amazon_url,
    source:     "extension",
    capturedAt: new Date().toISOString(),
  }

  const extractReq = toExtractorRequest(enrichedPayload)
  const extractRes = await extractAndSaveProduct(workspaceId, extractReq)

  if (!extractRes.success) {
    await query(
      `UPDATE extension_capture_items
       SET status = 'extract_failed',
           error_message = $2,
           capture_payload = $3::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [itemId, extractRes.error.slice(0, 500), JSON.stringify(enrichedPayload)]
    )
    await refreshCommandCounts(commandId)
    throw new Error(extractRes.error)
  }

  const existingPoolId = item.pool_id != null ? normalizePoolId(item.pool_id) : null
  const poolId = existingPoolId ?? extractRes.poolId
  let finalStatus: ExtensionCaptureItemStatus
  let publishCommandId = cmd.publish_command_id
  let publishJobId: number | null = item.scheduled_publish_job_id

  // Fail-closed Prime: never queue eBay publish unless selected offer is explicitly PRIME.
  if (cmd.operation_type === "bulk_direct_list" && poolId != null) {
    const reactivated = await reactivateFailedDirectListAvailabilityPool(workspaceId, poolId, item.asin)
    if (reactivated) {
      console.log("[ExtensionCapture] direct_list_retry_reactivated", { commandId, itemId, asin: item.asin, poolId })
    }
    const availability = await evaluatePoolAmazonAvailability(workspaceId, poolId, item.asin)
    const skipReason = resolveDirectListAvailabilitySkipReason(availability)
    if (skipReason === "NOT_PRIME" || skipReason === "PRIME_UNKNOWN"
      || skipReason === "OUT_OF_STOCK" || skipReason === "LIMITED_STOCK") {
      const blockMsg =
        skipReason === "NOT_PRIME" ? "NOT_PRIME: Explicit Prime eligibility is false"
        : skipReason === "PRIME_UNKNOWN" ? "PRIME_UNKNOWN: Explicit Prime eligibility could not be verified"
        : skipReason === "OUT_OF_STOCK" ? "OUT_OF_STOCK: Product is out of stock on Amazon"
        : skipReason === "LIMITED_STOCK"
          ? (availability.stockCount != null
            ? `LIMITED_STOCK: Only ${availability.stockCount} left in stock`
            : "LIMITED_STOCK: Only limited stock remaining on Amazon")
          : "STOCK_UNKNOWN: Explicit selected-offer stock status could not be verified"
      await query(
        `UPDATE extension_capture_items
         SET status = 'capture_blocked',
             pool_id = $2,
             error_message = $3,
             capture_payload = $4::jsonb,
             captured_at = NOW(),
             completed_at = NOW(),
             worker_id = NULL,
             lease_expires_at = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [itemId, poolId, blockMsg.slice(0, 500), JSON.stringify(enrichedPayload)]
      )
      await refreshCommandCounts(commandId)
      console.log("[ExtensionCapture] availability_blocked", {
        commandId, itemId, asin: item.asin, poolId, skipReason,
        primeStatus: availability.primeStatus,
        stockStatus: availability.stockStatus,
        stockCount: availability.stockCount,
      })
      return {
        ok: true,
        itemId,
        asin: item.asin,
        status: "capture_blocked",
        poolId,
        publishCommandId: null,
        publishJobId: null,
        alreadyCaptured: false,
      }
    }
  }

  if (cmd.operation_type === "bulk_add_to_pool") {
    finalStatus = "added_to_pool"
  } else {
    if (poolId != null) {
      const freshCmd = await loadCommand(workspaceId, commandId)
      if (!freshCmd) throw new Error("Capture command not found")
      const pub = await appendLivePublishJob(workspaceId, freshCmd, poolId, item.asin)
      publishCommandId = pub.publishCommandId
      publishJobId = pub.publishJobId
      finalStatus = "queued_for_publish"
    } else {
      finalStatus = "captured"
    }
  }

  await query(
    `UPDATE extension_capture_items
     SET status = $2,
         pool_id = $3,
         scheduled_publish_job_id = $4,
         capture_payload = $5::jsonb,
         captured_at = NOW(),
         completed_at = NOW(),
         error_message = NULL,
         worker_id = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [
      itemId,
      finalStatus,
      poolId,
      publishJobId,
      JSON.stringify(enrichedPayload),
    ]
  )

  await refreshCommandCounts(commandId)

  console.log("[ExtensionCapture] item_captured", {
    commandId,
    itemId,
    asin: item.asin,
    poolId,
    status: finalStatus,
    publishCommandId,
    publishJobId,
  })

  return {
    ok: true,
    itemId,
    asin: item.asin,
    status: finalStatus,
    poolId,
    publishCommandId,
    publishJobId,
    alreadyCaptured: false,
  }
}

export async function retryExtensionCaptureItemPromotion(
  workspaceId: string,
  commandId: number,
  itemId: number
): Promise<{ ok: true; listingId: string | null; promotion: PromotionPublic | null }> {
  const cmd = await loadCommand(workspaceId, commandId)
  if (!cmd) throw new Error("Capture command not found")
  const items = await loadItems(commandId)
  const item = items.find(i => i.id === itemId)
  if (!item) throw new Error("Capture item not found")
  const listingId = item.listing_id?.trim() || null
  if (!listingId) {
    return { ok: true, listingId: null, promotion: null }
  }
  const store = await findStore(workspaceId, cmd.store_code)
  if (!store) throw new Error("Store not found")
  const rate =
    cmd.promoted_ad_rate != null && Number.isFinite(Number(cmd.promoted_ad_rate))
      ? Number(cmd.promoted_ad_rate)
      : null
  const catalog = await query<{ id: number }>(
    `SELECT id FROM store_catalog_state
     WHERE workspace_id = $1::uuid AND store_id = $2 AND trim(ebay_item_id) = $3
     LIMIT 1`,
    [workspaceId, store.id, listingId]
  )
  const promotion = await applyListingPromotion({
    workspaceId,
    storeId: store.id,
    storeCode: store.store_code,
    catalogStateId: catalog.rows[0]?.id ?? null,
    listingId,
    enabled: true,
    rate,
    skipPriceProtection: true,
  })
  return { ok: true, listingId, promotion }
}

export async function cancelExtensionCaptureCommand(
  workspaceId: string,
  commandId:   number
): Promise<{ ok: true; commandId: number }> {
  await query(
    `UPDATE extension_capture_commands
     SET status = 'cancelled', updated_at = NOW(), completed_at = NOW()
     WHERE workspace_id = $1 AND id = $2
       AND status NOT IN ('completed', 'cancelled')`,
    [workspaceId, commandId]
  )
  await query(
    `UPDATE extension_capture_items
     SET status = 'failed', error_message = 'CANCELLED', updated_at = NOW()
     WHERE command_id = $1 AND status IN ('capture_pending', 'capturing')`,
    [commandId]
  )
  return { ok: true, commandId }
}
