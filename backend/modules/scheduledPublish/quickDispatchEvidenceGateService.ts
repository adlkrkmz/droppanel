// ----------------------------------------------------------------
// quickDispatchEvidenceGateService.ts — Quick Dispatch evidence routing
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { findExistingListedAsins } from "../asinImport/listedAsinGuard"
import {
  evaluatePoolAmazonAvailability,
  isPublishReadyFromAvailability,
  resolveAvailabilitySkipReason,
} from "../amazon/amazonAvailabilityGuardService"
import { createExtensionCaptureCommand } from "../extensionCapture/extensionCaptureService"
import {
  buildPoolEligibilityWhere,
  loadPoolItemsByIds,
  normalizePoolId,
  resolvePoolIneligibilityReason,
  splitEligiblePoolItems,
} from "../pool/poolEligibilityService"
import { createScheduledPublish } from "./scheduledPublishService"
import type {
  SchedulePublishRequest,
  SchedulePublishResponse,
  ScheduleSkipDetail,
} from "./scheduledPublishTypes"

export type ClassifiedPoolItem = {
  poolId: number
  asin:   string | null
}

export type EvidenceGateClassification = {
  readyForPublish: ClassifiedPoolItem[]
  needsCapture:    ClassifiedPoolItem[]
  skipped:         ScheduleSkipDetail[]
}

const ACTIVE_PUBLISH_JOB_STATUSES = ["scheduled", "running"] as const
const ACTIVE_PUBLISH_CMD_STATUSES = ["scheduled", "running", "paused"] as const
const ACTIVE_CAPTURE_CMD_STATUSES = ["queued", "capturing", "captured", "publishing"] as const
const ACTIVE_CAPTURE_ITEM_STATUSES = ["capture_pending", "capturing"] as const

const MAX_SCAN_MULTIPLIER = 15
const MAX_SCAN_LIMIT    = 500

type PoolCandidateRow = {
  poolId:          number
  asin:            string | null
  assignedStoreId: number | null
  status:          string
  pipelineStage:   string
}

async function findStoreId(workspaceId: string, storeCode: string): Promise<number | null> {
  const result = await query<{ id: number }>(
    `SELECT id FROM stores WHERE workspace_id = $1 AND store_code = $2 LIMIT 1`,
    [workspaceId, storeCode]
  )
  return result.rows[0]?.id ?? null
}

async function fetchReadyNextCandidates(
  workspaceId: string,
  limit:       number
): Promise<PoolCandidateRow[]> {
  const eligibilityWhere = buildPoolEligibilityWhere("ap")
  const result = await query<{
    pool_id: number; asin: string | null; assigned_store_id: number | null
    status: string; pipeline_stage: string
  }>(
    `SELECT ap.id AS pool_id, ar.asin, ap.assigned_store_id,
            ap.status::text AS status, ap.pipeline_stage::text AS pipeline_stage
     FROM asin_pool ap
     LEFT JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id = $1
       AND ${eligibilityWhere}
       AND ap.status = 'ready'
       AND ap.pipeline_stage IN ('validated', 'scraped', 'ai_generated')
     ORDER BY ap.id ASC
     LIMIT $2`,
    [workspaceId, limit]
  )
  return result.rows
    .map(r => {
      const poolId = normalizePoolId(r.pool_id)
      if (poolId == null) return null
      return {
        poolId,
        asin:            r.asin,
        assignedStoreId: r.assigned_store_id,
        status:          r.status,
        pipelineStage:   r.pipeline_stage,
      }
    })
    .filter((c): c is PoolCandidateRow => c != null)
}

async function fetchBlockedPoolIds(workspaceId: string): Promise<Set<number>> {
  const result = await query<{ pool_id: number }>(
    `SELECT DISTINCT pool_id FROM (
       SELECT spj.pool_id
       FROM scheduled_publish_jobs spj
       INNER JOIN scheduled_publish_commands spc ON spc.id = spj.command_id
       WHERE spj.workspace_id = $1
         AND spj.pool_id IS NOT NULL
         AND spj.status = ANY($2::text[])
         AND spc.status = ANY($3::text[])
       UNION
       SELECT eci.pool_id
       FROM extension_capture_items eci
       INNER JOIN extension_capture_commands ecc ON ecc.id = eci.command_id
       WHERE eci.workspace_id = $1
         AND eci.pool_id IS NOT NULL
         AND eci.status = ANY($4::text[])
         AND ecc.status = ANY($5::text[])
     ) blocked
     WHERE pool_id IS NOT NULL`,
    [
      workspaceId,
      [...ACTIVE_PUBLISH_JOB_STATUSES],
      [...ACTIVE_PUBLISH_CMD_STATUSES],
      [...ACTIVE_CAPTURE_ITEM_STATUSES],
      [...ACTIVE_CAPTURE_CMD_STATUSES],
    ]
  )
  return new Set(
    result.rows
      .map(r => normalizePoolId(r.pool_id))
      .filter((id): id is number => id != null)
  )
}

async function hasCachePublishEvidence(
  workspaceId: string,
  poolId:      number
): Promise<{ hasTitle: boolean; hasImages: boolean; hasPrice: boolean }> {
  const result = await query<{
    title: string | null
    price: number | null
    images: unknown
  }>(
    `SELECT apc.title, apc.price, apc.images
     FROM asin_pool ap
     LEFT JOIN amazon_product_cache apc ON apc.asin_registry_id = ap.asin_registry_id
     WHERE ap.workspace_id = $1 AND ap.id = $2
     LIMIT 1`,
    [workspaceId, poolId]
  )
  const row = result.rows[0]
  const images = Array.isArray(row?.images) ? row.images : []
  return {
    hasTitle:  Boolean(row?.title?.trim()),
    hasImages: images.length > 0,
    hasPrice:  row?.price != null && Number(row.price) > 0,
  }
}

async function classifyPoolItem(
  workspaceId: string,
  storeCode:   string,
  storeId:     number,
  candidate:   PoolCandidateRow,
  blockedIds:  Set<number>
): Promise<{ bucket: "ready" | "capture" | "skip"; detail?: ScheduleSkipDetail }> {
  const { poolId, asin } = candidate

  if (blockedIds.has(poolId)) {
    return { bucket: "skip", detail: { poolId, asin, reason: "ALREADY_QUEUED" } }
  }

  if (candidate.assignedStoreId != null && candidate.assignedStoreId !== storeId) {
    return { bucket: "skip", detail: { poolId, asin, reason: "STORE_CONFLICT" } }
  }

  const split = await splitEligiblePoolItems(workspaceId, [poolId])
  if (split.eligibleIds.length === 0) {
    const reason = split.skipDetails[0]?.reason ?? "INELIGIBLE"
    return { bucket: "skip", detail: { poolId, asin, reason } }
  }

  const loaded = await loadPoolItemsByIds(workspaceId, [poolId])
  const row = loaded.get(poolId)
  if (row) {
    const inelig = resolvePoolIneligibilityReason(row)
    if (inelig) {
      return { bucket: "skip", detail: { poolId, asin, reason: inelig } }
    }
  }

  const asinKey = asin?.trim().toUpperCase()
  if (asinKey) {
    const listed = await findExistingListedAsins(workspaceId, [asinKey])
    const match = listed.get(asinKey)
    if (match && match.storeCode === storeCode) {
      return { bucket: "skip", detail: { poolId, asin, reason: "DUPLICATE" } }
    }
  }

  const availability = await evaluatePoolAmazonAvailability(workspaceId, poolId, asin)
  const availReason = resolveAvailabilitySkipReason(availability)

  if (availReason === "NOT_PRIME") {
    return { bucket: "skip", detail: { poolId, asin, reason: "NOT_PRIME" } }
  }
  if (availReason === "PRIME_UNKNOWN") {
    // Trusted/explicit unknown → fail-closed skip. Missing evidence → still capture to verify.
    const trustedUnknown =
      availability.trustedSource
      || availability.reasons.includes("explicit_prime_unknown")
      || availability.reasons.includes("prime_signal_contradiction")
    if (trustedUnknown) {
      return { bucket: "skip", detail: { poolId, asin, reason: "PRIME_UNKNOWN" } }
    }
  }
  if (availReason === "OUT_OF_STOCK") {
    return { bucket: "skip", detail: { poolId, asin, reason: "OUT_OF_STOCK" } }
  }
  if (availReason === "LIMITED_STOCK") {
    return { bucket: "skip", detail: { poolId, asin, reason: "LIMITED_STOCK" } }
  }
  if (availReason === "STOCK_UNKNOWN") {
    // Trusted/explicit unknown after capture → skip. Missing evidence → capture to verify.
    const trustedStockUnknown =
      availability.trustedSource
      || availability.reasons.includes("explicit_stock_unknown")
      || availability.reasons.includes("stock_signal_contradiction")
      || availability.evidence.some(e => typeof e === "string" && e.startsWith("stockStatus_"))
    if (trustedStockUnknown) {
      return { bucket: "skip", detail: { poolId, asin, reason: "STOCK_UNKNOWN" } }
    }
  }
  if (availReason === "NO_VALID_PRICE") {
    return { bucket: "skip", detail: { poolId, asin, reason: "NO_VALID_PRICE" } }
  }

  const cache = await hasCachePublishEvidence(workspaceId, poolId)
  const publishReady = isPublishReadyFromAvailability(availability)
    && cache.hasTitle
    && cache.hasImages
    && cache.hasPrice

  if (publishReady) {
    return { bucket: "ready" }
  }

  const captureReason = availReason ?? "NEEDS_EXTENSION_CAPTURE"
  return {
    bucket: "capture",
    detail: { poolId, asin, reason: captureReason },
  }
}

export async function classifyPoolItemsForQuickDispatch(
  workspaceId: string,
  storeCode:   string,
  requestedCount: number,
  selectionMode:  "ready_next" | "selected",
  poolIds?:       number[]
): Promise<EvidenceGateClassification> {
  const storeId = await findStoreId(workspaceId, storeCode)
  if (!storeId) throw new Error("Store not found")

  const blockedIds = await fetchBlockedPoolIds(workspaceId)
  const readyForPublish: ClassifiedPoolItem[] = []
  const needsCapture: ClassifiedPoolItem[] = []
  const skipped: ScheduleSkipDetail[] = []

  let candidates: PoolCandidateRow[] = []

  if (selectionMode === "selected" && poolIds?.length) {
    const enriched = await fetchReadyNextCandidates(workspaceId, MAX_SCAN_LIMIT)
    const idSet = new Set(poolIds.map(id => normalizePoolId(id)).filter((id): id is number => id != null))
    candidates = enriched.filter(c => idSet.has(c.poolId))
    const order = new Map(poolIds.map((id, i) => [normalizePoolId(id), i]))
    candidates.sort((a, b) => (order.get(a.poolId) ?? 0) - (order.get(b.poolId) ?? 0))
  } else {
    const scanLimit = Math.min(Math.max(requestedCount * MAX_SCAN_MULTIPLIER, requestedCount), MAX_SCAN_LIMIT)
    candidates = await fetchReadyNextCandidates(workspaceId, scanLimit)
  }

  for (const candidate of candidates) {
    if (readyForPublish.length + needsCapture.length >= requestedCount) break

    const result = await classifyPoolItem(workspaceId, storeCode, storeId, candidate, blockedIds)
    const item: ClassifiedPoolItem = { poolId: candidate.poolId, asin: candidate.asin }

    if (result.bucket === "ready") {
      readyForPublish.push(item)
    } else if (result.bucket === "capture") {
      needsCapture.push(item)
    } else if (result.detail) {
      skipped.push(result.detail)
    }
  }

  return { readyForPublish, needsCapture, skipped }
}

export async function createQuickDispatchWithEvidenceGate(
  workspaceId: string,
  req:         SchedulePublishRequest
): Promise<SchedulePublishResponse> {
  const classification = await classifyPoolItemsForQuickDispatch(
    workspaceId,
    req.storeCode,
    req.count,
    req.selectionMode,
    req.poolIds
  )

  const { readyForPublish, needsCapture, skipped } = classification

  console.log("[QuickDispatchEvidenceGate] classified", {
    requestedCount:        req.count,
    readyForPublishCount:  readyForPublish.length,
    captureRequiredCount:  needsCapture.length,
    skippedCount:          skipped.length,
    storeCode:             req.storeCode,
    titleMode:             req.titleMode ?? "titlebot",
  })

  if (readyForPublish.length === 0 && needsCapture.length === 0) {
    const err = new Error("No eligible pool items for schedule.") as Error & { skipDetails?: ScheduleSkipDetail[] }
    err.skipDetails = skipped
    throw err
  }

  let publishResult: SchedulePublishResponse | null = null
  let publishCommandId: number | null = null

  if (readyForPublish.length > 0) {
    publishResult = await createScheduledPublish(workspaceId, {
      ...req,
      selectionMode: "selected",
      poolIds:       readyForPublish.map(i => i.poolId),
      count:         readyForPublish.length,
    })
    publishCommandId = publishResult.command!.id
    console.log("[QuickDispatchEvidenceGate] publish command created", {
      publishCommandId,
      itemCount: readyForPublish.length,
      storeCode: req.storeCode,
    })
    if (publishResult.skipDetails?.length) {
      skipped.push(...publishResult.skipDetails)
    }
  }

  let captureCommandId: number | null = null

  if (needsCapture.length > 0) {
    const captureRes = await createExtensionCaptureCommand(workspaceId, {
      operationType:    "bulk_direct_list",
      storeCode:        req.storeCode,
      items:            needsCapture.map(i => ({
        asin:   i.asin ?? "",
        poolId: i.poolId,
      })),
      titleMode:        req.titleMode,
      quantity:         req.quantity,
      delaySec:         req.intervalSeconds,
      publishCommandId: publishCommandId ?? undefined,
      publishJobSeq:    readyForPublish.length,
      metadata:         {
        source:            req.title === "Quick Dispatch" ? "quick_dispatch" : "scheduled_publish",
        scheduleStartAt:   req.startAt,
        scheduleTitle:     req.title ?? "Scheduled Publish",
        executionMode:     req.executionMode ?? "live",
        publishCommandId:  publishCommandId ?? null,
        readyPublishCount: readyForPublish.length,
      },
    })
    captureCommandId = captureRes.commandId
    console.log("[QuickDispatchEvidenceGate] capture command created", {
      captureCommandId,
      itemCount: needsCapture.length,
      storeCode: req.storeCode,
    })
  }

  const messageParts: string[] = []
  if (readyForPublish.length > 0) {
    messageParts.push(`${readyForPublish.length} item(s) queued for publish`)
  }
  if (needsCapture.length > 0) {
    messageParts.push(`${needsCapture.length} item(s) require extension capture`)
  }
  if (skipped.length > 0) {
    messageParts.push(`${skipped.length} skipped`)
  }

  const message = messageParts.join("; ") + "."

  if (publishResult) {
    return {
      ...publishResult,
      skipDetails: skipped.length > 0 ? skipped : publishResult.skipDetails,
      evidenceGate: {
        requestedCount:       req.count,
        readyForPublishCount: readyForPublish.length,
        captureRequiredCount: needsCapture.length,
        skippedCount:         skipped.length,
        publishCommandId,
        captureCommandId,
        message,
      },
    }
  }

  return {
    ok:          true,
    skipDetails: skipped.length > 0 ? skipped : undefined,
    evidenceGate: {
      requestedCount:       req.count,
      readyForPublishCount: 0,
      captureRequiredCount: needsCapture.length,
      skippedCount:         skipped.length,
      publishCommandId:     null,
      captureCommandId,
      message,
    },
  }
}
