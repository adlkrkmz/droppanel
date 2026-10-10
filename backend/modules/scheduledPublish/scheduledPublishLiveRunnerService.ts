// ----------------------------------------------------------------
// scheduledPublishLiveRunnerService.ts — manual single live job publish
// ----------------------------------------------------------------

import type { PoolClient } from "pg"
import { query, db } from "../../db/client"
import { dispatchSelectedPool } from "../admin/adminService"
import { findExistingListedAsins } from "../asinImport/listedAsinGuard"
import { runTimedPublishForStore } from "../publishQueue/publishQueueService"
import type { TitleMode } from "../publishQueue/publishQueueTypes"
import { parsePromotedRequest } from "../ebay/ebayPromotedTypes"
import {
  loadPoolItemByAsin,
  loadPoolItemsByIds,
  normalizePoolId,
  resolvePoolIneligibilityReason,
  splitEligiblePoolItems,
} from "../pool/poolEligibilityService"
import { isAmazonAsin } from "../pool/poolPrimeGuardService"
import {
  evaluatePoolAmazonAvailability,
  resolveDirectListAvailabilitySkipReason,
  resolveAvailabilityJobErrorMessage,
  resolveAvailabilitySkipReason,
} from "../amazon/amazonAvailabilityGuardService"
import {
  processAvailabilityArchiveSkip,
  sendNeedsAmazonValidationTelegram,
} from "../pool/poolPrimeGuardService"
import { ensureAmazonProductCacheForPoolItem } from "../pool/poolAmazonCachePrepareService"
import { isStoreConnected } from "../stockGuard/stockGuardActiveStores"
import { getSettingsByStore } from "../storeSettings/storeSettingsRepository"
import { finalizeCommandProgress } from "./scheduledPublishService"
import { finalizeExtensionCaptureForPublishJob } from "../extensionCapture/extensionCaptureService"
import { attachPromotionAfterPublish } from "../ebay/ebayPromotedAdService"
import { parseCatalogStateId } from "../listings/promotionPriceProtectionService"
import type {
  ScheduledLiveRunnerResult,
  ScheduledLiveRunnerRunResponse,
} from "./scheduledPublishTypes"

const LIVE_PUBLISH_SOURCE = "scheduled_live_single_job"

type DueLiveJobRow = {
  job_id:     number
  command_id: number
  pool_id:    number
  asin:       string | null
  scheduled_at: string
  store_code: string
  store_id:   number
  title_mode: string
  quantity:   number
  metadata:   Record<string, unknown> | null
  promoted_enabled: boolean
  promoted_ad_rate: string | null
}

type GuardOutcome =
  | { ok: true }
  | { ok: false; terminal: "skipped" | "failed"; reason: string }

function truncate(msg: string, max = 500): string {
  return msg.length > max ? msg.slice(0, max) : msg
}

async function markJobRunning(client: PoolClient, jobId: number): Promise<void> {
  await client.query(
    `UPDATE scheduled_publish_jobs
     SET status = 'running',
         attempt_count = attempt_count + 1,
         updated_at = NOW()
     WHERE id = $1`,
    [jobId]
  )
}

async function markCommandRunning(client: PoolClient, commandId: number): Promise<void> {
  await client.query(
    `UPDATE scheduled_publish_commands
     SET status = 'running',
         completed_at = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND status IN ('scheduled', 'completed')`,
    [commandId]
  )
}

async function claimOneDueLiveJob(
  workspaceId: string,
  opts: { storeCode?: string | null; commandId?: number | null }
): Promise<DueLiveJobRow | null> {
  const storeCode = opts.storeCode?.trim() || null
  const commandId = opts.commandId ?? null

  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const result = await client.query<DueLiveJobRow>(
      `SELECT
         spj.id AS job_id,
         spj.command_id,
         spj.pool_id,
         spj.asin,
         spj.scheduled_at::text AS scheduled_at,
         spc.store_code,
         spc.store_id,
         spc.title_mode,
         spc.quantity,
         spc.metadata,
         COALESCE(spj.promoted_enabled, false) AS promoted_enabled,
         spj.promoted_ad_rate::text AS promoted_ad_rate
       FROM scheduled_publish_jobs spj
       INNER JOIN scheduled_publish_commands spc ON spc.id = spj.command_id
       WHERE spj.workspace_id = $1
         AND spj.status = 'scheduled'
         AND spj.scheduled_at <= NOW()
         AND (
           spc.status IN ('scheduled', 'running')
           OR (
             spc.status = 'completed'
             AND EXISTS (
               SELECT 1 FROM scheduled_publish_jobs spj_pending
               WHERE spj_pending.command_id = spc.id
                 AND spj_pending.status IN ('scheduled', 'running')
             )
           )
         )
         AND COALESCE(spc.metadata->>'executionMode', 'simulation') = 'live'
         AND ($2::text IS NULL OR spc.store_code = $2)
         AND ($3::bigint IS NULL OR spc.id = $3)
       ORDER BY spj.scheduled_at ASC, spj.id ASC
       LIMIT 1
       FOR UPDATE OF spj SKIP LOCKED`,
      [workspaceId, storeCode, commandId]
    )

    const row = result.rows[0]
    if (!row) {
      await client.query("COMMIT")
      return null
    }

    await markJobRunning(client, row.job_id)
    await markCommandRunning(client, row.command_id)
    await client.query("COMMIT")
    return row
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

async function hasActiveCaptureForPool(
  workspaceId: string,
  poolId:      number
): Promise<boolean> {
  const result = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt
     FROM extension_capture_items eci
     INNER JOIN extension_capture_commands ecc ON ecc.id = eci.command_id
     WHERE eci.workspace_id = $1
       AND eci.pool_id = $2
       AND eci.status IN ('capture_pending', 'capturing')
       AND ecc.status NOT IN ('cancelled', 'completed', 'failed')`,
    [workspaceId, poolId]
  )
  return parseInt(result.rows[0]?.cnt ?? "0", 10) > 0
}

async function hasExtensionCaptureSnapshot(
  workspaceId: string,
  poolId:      number
): Promise<boolean> {
  const result = await query<{
    price: number | null; title: string | null; images: unknown; attributes: unknown
  }>(
    `SELECT apc.price, apc.title, apc.images, apc.attributes
     FROM asin_pool ap
     LEFT JOIN amazon_product_cache apc ON apc.asin_registry_id = ap.asin_registry_id
     WHERE ap.workspace_id = $1 AND ap.id = $2
     LIMIT 1`,
    [workspaceId, poolId]
  )
  const row = result.rows[0]
  if (!row?.title?.trim()) return false
  const images = Array.isArray(row.images) ? row.images : []
  if (images.length === 0) return false
  if (row.price == null || Number(row.price) <= 0) return false
  const attrs = row.attributes && typeof row.attributes === "object"
    ? row.attributes as Record<string, unknown>
    : {}
  return attrs.source === "extension" && typeof attrs.capturedAt === "string"
}

async function validateLivePublishReadiness(
  workspaceId: string,
  row:         DueLiveJobRow
): Promise<GuardOutcome> {
  const poolId = normalizePoolId(row.pool_id)
  if (poolId == null) {
    return { ok: false, terminal: "skipped", reason: "POOL_ITEM_MISSING_OR_DELETED" }
  }

  let poolRow = (await loadPoolItemsByIds(workspaceId, [poolId])).get(poolId) ?? null
  if (!poolRow && row.asin) {
    poolRow = await loadPoolItemByAsin(workspaceId, row.asin)
  }

  if (!poolRow) {
    console.warn("[BulkJobRunner] pool item missing — possible physical delete", {
      commandId: row.command_id,
      itemId:    row.job_id,
      poolId,
      asin:      row.asin,
      workspaceId,
      storeCode: row.store_code,
    })
    return { ok: false, terminal: "skipped", reason: "POOL_ITEM_MISSING_OR_DELETED" }
  }

  const ineligible = resolvePoolIneligibilityReason(poolRow)
  if (ineligible) {
    return { ok: false, terminal: "skipped", reason: ineligible }
  }

  if (await hasActiveCaptureForPool(workspaceId, poolId)) {
    return { ok: false, terminal: "skipped", reason: "WAITING_FOR_CAPTURE" }
  }

  const asinForCheck = row.asin?.trim() ?? poolRow.asin ?? ""
  if (asinForCheck && isAmazonAsin(asinForCheck)) {
    const availability = await evaluatePoolAmazonAvailability(workspaceId, poolId, asinForCheck)
    const isDirectListCapture = row.metadata?.source === "extension_capture"
    let skipReason = isDirectListCapture
      ? resolveDirectListAvailabilitySkipReason(availability)
      : resolveAvailabilitySkipReason(availability)
    // Fail-closed for Prime and Limited Stock: never soft-pass these even with a capture snapshot.
    // Snapshot may still soft-pass price unknowns only.
    const snapshotReady = await hasExtensionCaptureSnapshot(workspaceId, poolId)
    if (snapshotReady && skipReason) {
      const softPassOnly = new Set([
        "PRICE_UNKNOWN", "NEEDS_AMAZON_VALIDATION",
      ])
      if (softPassOnly.has(skipReason)) {
        skipReason = null
      }
    }
    if (skipReason) {
      const jobError = resolveAvailabilityJobErrorMessage(skipReason)
      if (
        skipReason === "NOT_PRIME"
        || skipReason === "OUT_OF_STOCK"
        || skipReason === "LIMITED_STOCK"
        || skipReason === "STOCK_UNKNOWN"
        || skipReason === "PRIME_UNKNOWN"
      ) {
        if (row.metadata?.source !== "extension_capture") {
          await processAvailabilityArchiveSkip(
            workspaceId,
            [{ poolId, asin: asinForCheck, reason: skipReason }],
            { skipActiveJobs: false, notify: true }
          )
        }
      } else if (!snapshotReady && (
        skipReason === "NEEDS_AMAZON_VALIDATION"
      )) {
        await sendNeedsAmazonValidationTelegram([asinForCheck])
      }
      return { ok: false, terminal: "skipped", reason: jobError }
    }
  }

  const split = await splitEligiblePoolItems(workspaceId, [poolId])
  if (split.eligibleIds.length === 0) {
    const reason = split.skipDetails[0]?.reason ?? "POOL_ITEM_NOT_ELIGIBLE"
    return { ok: false, terminal: "skipped", reason }
  }

  const storeCheck = await query<{ status: string }>(
    `SELECT status FROM stores WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
    [workspaceId, row.store_id]
  )
  const storeStatus = storeCheck.rows[0]?.status
  if (storeStatus !== "active") {
    return { ok: false, terminal: "failed", reason: "Store is not active" }
  }

  if (!(await isStoreConnected(workspaceId, row.store_id))) {
    return { ok: false, terminal: "failed", reason: "Store is not connected to eBay" }
  }

  const settings = await getSettingsByStore(workspaceId, row.store_id)
  if (!settings || !settings.enabled) {
    return { ok: false, terminal: "failed", reason: "Store settings missing or disabled" }
  }
  if (
    !settings.merchantLocationKey?.trim() ||
    !settings.paymentPolicyId?.trim() ||
    !settings.returnPolicyId?.trim() ||
    !settings.fulfillmentPolicyId?.trim()
  ) {
    return { ok: false, terminal: "failed", reason: "Store publish policies or merchant location incomplete" }
  }

  const asin = row.asin?.trim().toUpperCase()
  if (asin) {
    const listed = await findExistingListedAsins(workspaceId, [asin])
    const match = listed.get(asin)
    if (match && match.storeCode === row.store_code) {
      return { ok: false, terminal: "skipped", reason: "MY_LISTINGS_DUPLICATE" }
    }
  }

  return { ok: true }
}

async function updateJobTerminal(
  jobId:    number,
  status:   "published" | "failed" | "skipped",
  payload:  Record<string, unknown>,
  errorMsg: string | null
): Promise<void> {
  if (status === "published") {
    await query(
      `UPDATE scheduled_publish_jobs
       SET status = 'published',
           published_at = NOW(),
           result = $2::jsonb,
           error_message = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [jobId, JSON.stringify(payload)]
    )
    return
  }

  if (status === "skipped") {
    await query(
      `UPDATE scheduled_publish_jobs
       SET status = 'skipped',
           error_message = $2,
           result = $3::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [jobId, errorMsg, JSON.stringify(payload)]
    )
    return
  }

  await query(
    `UPDATE scheduled_publish_jobs
     SET status = 'failed',
         failed_at = NOW(),
         error_message = $2,
         result = $3::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [jobId, errorMsg, JSON.stringify(payload)]
  )
}

async function lookupEbayItemId(
  workspaceId: string,
  storeId:     number,
  asin:        string | null
): Promise<string | null> {
  if (!asin) return null
  const result = await query<{ ebay_item_id: string | null }>(
    `SELECT scs.ebay_item_id
     FROM store_catalog_state scs
     INNER JOIN asin_registry ar ON ar.id = scs.asin_registry_id
     WHERE scs.workspace_id = $1
       AND scs.store_id = $2
       AND ar.asin = $3
     ORDER BY scs.updated_at DESC NULLS LAST
     LIMIT 1`,
    [workspaceId, storeId, asin.trim().toUpperCase()]
  )
  return result.rows[0]?.ebay_item_id ?? null
}

type PayloadDiagnostics = {
  poolId:             number
  asin?:              string | null
  storeCode:          string
  assignedStoreCode?: string | null
  pipelineStage?:     string
  status?:            string
  listingStatus?:     string
  archivedAt?:        string | null
  hasAmazonCache?:    boolean
  missingReason:      string
}

async function diagnosePayloadBlock(
  workspaceId: string,
  poolId:      number,
  storeCode:   string
): Promise<PayloadDiagnostics> {
  const result = await query<{
    asin:                 string | null
    pipeline_stage:       string
    status:               string
    listing_status:       string
    archived_at:          string | null
    assigned_store_code:  string | null
    has_amazon_cache:     boolean
  }>(
    `SELECT
       ar.asin,
       ap.pipeline_stage::text AS pipeline_stage,
       ap.status::text AS status,
       ap.listing_status::text AS listing_status,
       ap.archived_at::text AS archived_at,
       s.store_code AS assigned_store_code,
       (apc.asin_registry_id IS NOT NULL) AS has_amazon_cache
     FROM asin_pool ap
     LEFT JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     LEFT JOIN stores s ON s.id = ap.assigned_store_id
     LEFT JOIN amazon_product_cache apc ON apc.asin_registry_id = ap.asin_registry_id
     WHERE ap.workspace_id = $1 AND ap.id = $2`,
    [workspaceId, poolId]
  )

  const row = result.rows[0]
  if (!row) {
    return { poolId, storeCode, missingReason: "POOL_ITEM_NOT_FOUND" }
  }

  let missingReason = "PAYLOAD_SQL_FILTERED_OUT"
  if (row.archived_at) missingReason = "POOL_ITEM_ARCHIVED"
  else if (row.pipeline_stage === "listed") missingReason = "POOL_ITEM_ALREADY_LISTED"
  else if (row.status === "completed") missingReason = "POOL_ITEM_COMPLETED"
  else if (row.listing_status === "success") missingReason = "POOL_ITEM_SUCCESS"
  else if (!row.has_amazon_cache) missingReason = "MISSING_AMAZON_PRODUCT_CACHE"
  else if (row.assigned_store_code && row.assigned_store_code !== storeCode) {
    missingReason = "STORE_ASSIGNMENT_MISMATCH"
  } else if (!["ready", "skipped"].includes(row.status)) {
    missingReason = "POOL_STATUS_NOT_PUBLISH_READY"
  } else if (!["validated", "scraped", "ai_generated"].includes(row.pipeline_stage)) {
    missingReason = "PIPELINE_STAGE_NOT_PUBLISH_READY"
  }

  return {
    poolId,
    asin:              row.asin,
    storeCode,
    assignedStoreCode: row.assigned_store_code,
    pipelineStage:     row.pipeline_stage,
    status:            row.status,
    listingStatus:     row.listing_status,
    archivedAt:        row.archived_at,
    hasAmazonCache:    row.has_amazon_cache,
    missingReason,
  }
}

export async function runLiveOneDueJob(
  workspaceId: string,
  opts: { storeCode?: string | null; commandId?: number | null }
): Promise<ScheduledLiveRunnerRunResponse> {
  const row = await claimOneDueLiveJob(workspaceId, opts)
  if (!row) {
    return {
      ok:        true,
      mode:      "live",
      processed: 0,
      published: 0,
      failed:    0,
      skipped:   0,
      message:   "No due live jobs found.",
    }
  }

  const poolId = normalizePoolId(row.pool_id)

  const baseResult: ScheduledLiveRunnerResult = {
    jobId:     row.job_id,
    commandId: row.command_id,
    poolId:    poolId ?? row.pool_id,
    asin:      row.asin,
  }

  const guard = await validateLivePublishReadiness(workspaceId, row)
  if (!guard.ok) {
    const payload = guard.terminal === "skipped"
      ? { skipped: true, reason: guard.reason, live: true }
      : { live: true, published: false, error: guard.reason }

    await updateJobTerminal(row.job_id, guard.terminal, payload, guard.reason)
    await finalizeCommandProgress(workspaceId, row.command_id)
    await finalizeExtensionCaptureForPublishJob({
      workspaceId,
      publishJobId: row.job_id,
      outcome: guard.terminal === "skipped" ? "skipped" : "failed",
      errorMessage: guard.reason,
    })

    console.log("[BulkJobRunner] item", {
      commandId: row.command_id,
      itemId:    row.job_id,
      poolId:    poolId ?? row.pool_id,
      asin:      row.asin,
      storeCode: row.store_code,
      status:    guard.terminal,
      reason:    guard.reason,
    })

    return {
      ok:        true,
      mode:      "live",
      processed: 1,
      published: 0,
      failed:    guard.terminal === "failed" ? 1 : 0,
      skipped:   guard.terminal === "skipped" ? 1 : 0,
      result:    { ...baseResult, status: guard.terminal, message: guard.reason },
    }
  }

  const titleMode = (
    row.title_mode === "ai" ? "ai"
    : row.title_mode === "original" ? "original"
    : "titlebot"
  ) as TitleMode

  if (poolId == null) {
    await updateJobTerminal(row.job_id, "skipped", { skipped: true, reason: "POOL_ITEM_NOT_FOUND" }, "POOL_ITEM_NOT_FOUND")
    await finalizeCommandProgress(workspaceId, row.command_id)
    await finalizeExtensionCaptureForPublishJob({
      workspaceId,
      publishJobId: row.job_id,
      outcome: "skipped",
      errorMessage: "POOL_ITEM_NOT_FOUND",
    })
    return {
      ok: true, mode: "live", processed: 1, published: 0, failed: 0, skipped: 1,
      result: { ...baseResult, status: "skipped", message: "POOL_ITEM_NOT_FOUND" },
    }
  }

  try {
    const dispatch = await dispatchSelectedPool(workspaceId, [poolId], row.store_code)
    if (!dispatch.assignedPoolIds.includes(poolId)) {
      const reason = dispatch.skipDetails?.[0]?.reason ?? "DISPATCH_ASSIGNMENT_FAILED"
      const diagnostics = await diagnosePayloadBlock(workspaceId, poolId, row.store_code)
      await updateJobTerminal(
        row.job_id,
        "skipped",
        { skipped: true, reason, live: true, diagnostics, source: LIVE_PUBLISH_SOURCE },
        reason
      )
      await finalizeCommandProgress(workspaceId, row.command_id)
      await finalizeExtensionCaptureForPublishJob({
        workspaceId,
        publishJobId: row.job_id,
        outcome: "skipped",
        errorMessage: reason,
      })
      return {
        ok:        true,
        mode:      "live",
        processed: 1,
        published: 0,
        failed:    0,
        skipped:   1,
        result:    { ...baseResult, status: "skipped", message: reason },
      }
    }

    const cachePrep = await ensureAmazonProductCacheForPoolItem(workspaceId, poolId)
    if (!cachePrep.cacheReady) {
      const reason = cachePrep.reason ?? "PRODUCT_EXTRACT_FAILED"
      const diagnostics = {
        ...(await diagnosePayloadBlock(workspaceId, poolId, row.store_code)),
        cacheBefore: cachePrep.cacheBefore,
        cachePrepareAttempted: cachePrep.cachePrepareAttempted,
        cachePrepared: cachePrep.cachePrepared,
        productExtractError: cachePrep.productExtractError ?? cachePrep.message,
      }
      await updateJobTerminal(
        row.job_id,
        "failed",
        {
          live: true,
          published: false,
          error: cachePrep.message ?? reason,
          reason,
          diagnostics,
          source: LIVE_PUBLISH_SOURCE,
        },
        truncate(cachePrep.message ?? String(reason))
      )
      await finalizeCommandProgress(workspaceId, row.command_id)
      await finalizeExtensionCaptureForPublishJob({
        workspaceId,
        publishJobId: row.job_id,
        outcome: "failed",
        errorMessage: cachePrep.message ?? reason,
      })
      return {
        ok:        true,
        mode:      "live",
        processed: 1,
        published: 0,
        failed:    1,
        skipped:   0,
        result:    {
          ...baseResult,
          status: "failed",
          message: cachePrep.message ?? "Amazon product data could not be prepared automatically.",
        },
      }
    }

    const promoted = parsePromotedRequest({
      promotedEnabled: row.promoted_enabled,
      promotedAdRate: row.promoted_ad_rate,
    })
    if (!promoted.ok) {
      await updateJobTerminal(
        row.job_id,
        "failed",
        { live: true, published: false, error: promoted.code, message: promoted.message },
        promoted.code
      )
      await finalizeCommandProgress(workspaceId, row.command_id)
      await finalizeExtensionCaptureForPublishJob({
        workspaceId,
        publishJobId: row.job_id,
        outcome: "failed",
        errorMessage: promoted.message,
      })
      return {
        ok: true,
        mode: "live",
        processed: 1,
        published: 0,
        failed: 1,
        skipped: 0,
        result: { ...baseResult, status: "failed", message: promoted.message },
      }
    }

    const publishResult = await runTimedPublishForStore({
      workspaceId,
      storeCode:      row.store_code,
      storeId:        row.store_id,
      delaySeconds:   0,
      limit:          1,
      dryRun:         false,
      simulationMode: false,
      quantity:       row.quantity,
      ebayOauthToken: process.env.EBAY_OAUTH_TOKEN ?? "",
      ebaySandbox:    (process.env.EBAY_SANDBOX ?? "true") !== "false",
      targetPoolIds:  [poolId],
      titleMode,
      source:         LIVE_PUBLISH_SOURCE,
      archiveAvailabilityFailures: row.metadata?.source !== "extension_capture",
      allowUnknownStockForDirectList: row.metadata?.source === "extension_capture",
      promotion: promoted.enabled
        ? { enabled: true, adRatePercent: promoted.rate }
        : undefined,
    })

    const item = publishResult.items.find(i => i.poolId === poolId) ?? publishResult.items[0]

    if (!item || publishResult.attempted === 0) {
      const diagnostics = {
        ...(await diagnosePayloadBlock(workspaceId, poolId, row.store_code)),
        cacheBefore: cachePrep.cacheBefore,
        cachePrepareAttempted: cachePrep.cachePrepareAttempted,
        cachePrepared: cachePrep.cachePrepared,
      }
      const availability = await evaluatePoolAmazonAvailability(workspaceId, poolId, row.asin)
      const availabilityReason = row.metadata?.source === "extension_capture"
        ? resolveDirectListAvailabilitySkipReason(availability)
        : resolveAvailabilitySkipReason(availability)
      const reason = availabilityReason ?? diagnostics.missingReason ?? "PAYLOAD_SQL_FILTERED_OUT"
      await updateJobTerminal(
        row.job_id,
        "failed",
        {
          live: true,
          published: false,
          error: reason,
          diagnostics,
          source: LIVE_PUBLISH_SOURCE,
        },
        truncate(`${reason} poolId=${poolId}`)
      )
      await finalizeCommandProgress(workspaceId, row.command_id)
      await finalizeExtensionCaptureForPublishJob({
        workspaceId,
        publishJobId: row.job_id,
        outcome: "failed",
        errorMessage: reason,
      })
      return {
        ok:        true,
        mode:      "live",
        processed: 1,
        published: 0,
        failed:    1,
        skipped:   0,
        result:    {
          ...baseResult,
          status: "failed",
          message:
            reason === "MISSING_AMAZON_PRODUCT_CACHE" && cachePrep.cachePrepareAttempted
              ? "Amazon product data could not be prepared automatically."
              : reason,
        },
      }
    }

    if (item.status === "success") {
      const publishedAt = new Date().toISOString()
      const ebayItemId =
        (typeof item.ebayListingId === "string" && item.ebayListingId.trim()) ||
        (await lookupEbayItemId(workspaceId, row.store_id, row.asin))
      const resultPayload = {
        live:          true,
        published:     true,
        titleMode,
        executionMode: "live",
        source:        LIVE_PUBLISH_SOURCE,
        poolId,
        asin:          row.asin,
        storeCode:     row.store_code,
        storeId:       row.store_id,
        publishedAt,
        ebayItemId:    ebayItemId || null,
        cacheBefore:           cachePrep.cacheBefore,
        cachePrepareAttempted: cachePrep.cachePrepareAttempted,
        cachePrepared:         cachePrep.cachePrepared,
        publishResult: "Published via scheduled live runner",
      }

      await updateJobTerminal(row.job_id, "published", resultPayload, null)
      await finalizeCommandProgress(workspaceId, row.command_id)
      await finalizeExtensionCaptureForPublishJob({
        workspaceId,
        publishJobId: row.job_id,
        outcome: "published",
      })

      let promotion = null as Awaited<ReturnType<typeof attachPromotionAfterPublish>>
      if (row.promoted_enabled === true && ebayItemId) {
        const catalog = await query<{ id: string | number }>(
          `SELECT id FROM store_catalog_state
           WHERE workspace_id = $1::uuid AND store_id = $2 AND trim(ebay_item_id) = $3
           LIMIT 1`,
          [workspaceId, row.store_id, ebayItemId]
        )
        const rate = row.promoted_ad_rate != null ? Number(row.promoted_ad_rate) : null
        promotion = await attachPromotionAfterPublish({
          workspaceId,
          storeId: row.store_id,
          storeCode: row.store_code,
          catalogStateId: parseCatalogStateId(catalog.rows[0]?.id),
          listingId: ebayItemId,
          enabled: true,
          rate: Number.isFinite(rate as number) ? rate : null,
        })
        await query(
          `UPDATE scheduled_publish_jobs
           SET result = COALESCE(result, '{}'::jsonb) || jsonb_build_object(
             'promotionStatus', $2::text,
             'promotionCode', $3::text
           ),
           updated_at = NOW()
           WHERE id = $1`,
          [row.job_id, promotion?.status ?? "FAILED", promotion?.code ?? null]
        )
      }

      console.log("[BulkJobRunner] item", {
        commandId: row.command_id,
        itemId:    row.job_id,
        poolId,
        asin:      row.asin,
        storeCode: row.store_code,
        storeId:   row.store_id,
        status:    "listed",
        reason:    "published",
        ebayItemId: ebayItemId || null,
      })

      return {
        ok:        true,
        mode:      "live",
        processed: 1,
        published: 1,
        failed:    0,
        skipped:   0,
        result:    {
          ...baseResult,
          status:     promotion && promotion.status === "FAILED" ? "listed_promotion_failed" : "published",
          ebayItemId: ebayItemId ?? undefined,
          promotion,
          message:    cachePrep.cachePrepared
            ? "Published to eBay. Amazon data prepared automatically."
            : "Published to eBay.",
        },
      }
    }

    if (item.status === "skipped") {
      const reason = truncate(item.error ?? item.status)
      await updateJobTerminal(
        row.job_id,
        "skipped",
        { skipped: true, reason, live: true },
        reason
      )
      await finalizeCommandProgress(workspaceId, row.command_id)
      await finalizeExtensionCaptureForPublishJob({
        workspaceId,
        publishJobId: row.job_id,
        outcome: "skipped",
        errorMessage: reason,
      })
      return {
        ok:        true,
        mode:      "live",
        processed: 1,
        published: 0,
        failed:    0,
        skipped:   1,
        result:    { ...baseResult, status: "skipped", message: reason },
      }
    }

    if (item.status === "blocked") {
      const reason = truncate(item.error ?? item.status)
      await updateJobTerminal(
        row.job_id,
        "failed",
        { live: true, published: false, error: reason },
        reason
      )
      await finalizeCommandProgress(workspaceId, row.command_id)
      await finalizeExtensionCaptureForPublishJob({
        workspaceId,
        publishJobId: row.job_id,
        outcome: "blocked",
        errorMessage: reason,
      })
      return {
        ok:        true,
        mode:      "live",
        processed: 1,
        published: 0,
        failed:    1,
        skipped:   0,
        result:    { ...baseResult, status: "failed", message: reason },
      }
    }

    const failMsg = truncate(item.error ?? "Publish failed")
    await updateJobTerminal(
      row.job_id,
      "failed",
      { live: true, published: false, error: failMsg },
      failMsg
    )
    await finalizeCommandProgress(workspaceId, row.command_id)
    await finalizeExtensionCaptureForPublishJob({
      workspaceId,
      publishJobId: row.job_id,
      outcome: "failed",
      errorMessage: failMsg,
    })

    return {
      ok:        true,
      mode:      "live",
      processed: 1,
      published: 0,
      failed:    1,
      skipped:   0,
      result:    { ...baseResult, status: "failed", message: failMsg },
    }
  } catch (e) {
    const msg = truncate(e instanceof Error ? e.message : String(e))
    await updateJobTerminal(
      row.job_id,
      "failed",
      { live: true, published: false, error: msg },
      msg
    )
    await finalizeCommandProgress(workspaceId, row.command_id)
    await finalizeExtensionCaptureForPublishJob({
      workspaceId,
      publishJobId: row.job_id,
      outcome: "failed",
      errorMessage: msg,
    })

    return {
      ok:        true,
      mode:      "live",
      processed: 1,
      published: 0,
      failed:    1,
      skipped:   0,
      result:    { ...baseResult, status: "failed", message: msg },
    }
  }
}
