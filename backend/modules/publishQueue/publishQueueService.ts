// ----------------------------------------------------------------
// publishQueueService.ts
//
// targetPoolIds: dispatch sonrasi dogrudan bu pool kayitlari publish edilir.
//
// Publish pipeline (runInventoryFlow):
//   amazon_product_cache.images -> processAndUploadImages -> R2 URLs
//   ai_listing_cache -> title, bullets, description, item_specifics (payload)
//   OAuth: getValidAccessToken(workspaceId, storeCode, simulationMode)
//   inventory item + offer + publish
// ----------------------------------------------------------------

import {
  fetchPublishQueueForStore,
  findStoreById,
  findStoreIdByCode,
  markPoolAsPublishFailed,
  markPoolAsSkipped,
} from "./publishQueueRepository"
import {
  buildEbayListingPayloads,
  type EbayListingPayload,
} from "../ebay/ebayPayloadService"
import {
  runInventoryFlow,
  type InventoryFlowClientOptions,
} from "../ebay/ebayInventoryService"
import {
  persistPublishResults,
  zipPayloadsAndResults,
} from "../ebay/ebayPublishPersistenceService"
import { query } from "../../db/client"
import { addNotification } from "../notifications/notificationService"
import {
  evaluatePoolAmazonAvailability,
  resolveDirectListAvailabilitySkipReason,
  resolveAvailabilitySkipReason,
} from "../amazon/amazonAvailabilityGuardService"
import {
  archivePoolItemForHighRisk,
  isAmazonAsin,
  processAvailabilityArchiveSkip,
} from "../pool/poolPrimeGuardService"
import { getSettingsByStore } from "../storeSettings/storeSettingsRepository"
import { runPublishGuard } from "../publishGuard/publishGuardService"
import type { StoreSettingsRow } from "../storeSettings/storeSettingsTypes"
import type {
  PublishItemResult,
  TimedPublishOptions,
  TimedPublishRunResult,
} from "./publishQueueTypes"
import { findExistingListedAsins } from "../asinImport/listedAsinGuard"

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isEbayHighRiskPoolDeleteError(msg: string): boolean {
  if (!msg) return false
  const low = msg.toLowerCase()
  return (
    msg.includes("25019") ||
    low.includes("high-risk") ||
    low.includes("high risk")
  )
}

async function publishOne(
  payload:        EbayListingPayload,
  storeSettings:  StoreSettingsRow | null,
  ebayFlowOpts:   InventoryFlowClientOptions,
  dryRun:         boolean
): Promise<PublishItemResult> {
  const t0    = Date.now()
  const guard = runPublishGuard({ payload, storeSettings })

  if (!guard.isPublishable) {
    console.log(`  [Guard] BLOCKED: ${payload.asin} | score=${guard.score} errors=${guard.errors.length}`)
    guard.errors.forEach(e => console.log(`    x ${e}`))
    return {
      poolId: payload.poolId,
      asin:   payload.asin,
      sku:    payload.sku,
      status: "blocked",
      error:  guard.errors[0] ?? "Guard blocked publish",
      durationMs: Date.now() - t0,
      guardScore: guard.score,
      guardErrors:   guard.errors,
      guardWarnings: guard.warnings,
    }
  }

  if (guard.warnings.length > 0) {
    console.log(`  [Guard] WARN: ${payload.asin} - ${guard.warnings.length} warning(s)`)
  }

  if (dryRun) {
    console.log(`  [DryRun] Would publish: ${payload.asin} score=${guard.score}`)
    return {
      poolId: payload.poolId,
      asin:   payload.asin,
      sku:    payload.sku,
      status: "skipped",
      error:  null,
      durationMs: Date.now() - t0,
      guardScore: guard.score,
      guardErrors:   [],
      guardWarnings: guard.warnings,
    }
  }

  try {
    const alreadyLive = await findExistingListedAsins(payload.workspaceId, [payload.asin])

    if (alreadyLive.has(payload.asin)) {
      const match = alreadyLive.get(payload.asin)!
      console.log(`  [Guard] SKIP: ${payload.asin} already live in connected store ${match.storeCode}`)
      return {
        poolId: payload.poolId,
        asin: payload.asin,
        sku: payload.sku,
        status: "skipped",
        error: null,
        durationMs: Date.now() - t0,
        guardScore: null,
        guardErrors: [],
        guardWarnings: [`Already live in connected store ${match.storeCode}`],
      }
    }

    const flowResult = await runInventoryFlow(payload, ebayFlowOpts)
    const didFail =
      flowResult.inventoryItemStatus === "failed" || flowResult.inventoryItemStatus === "FAILED" ||
      flowResult.offerStatus         === "failed" || flowResult.offerStatus         === "FAILED" ||
      flowResult.publishStatus       === "failed" || flowResult.publishStatus       === "FAILED"

    if (didFail) {
      const errorMsg = flowResult.error ?? ""
      if (isEbayHighRiskPoolDeleteError(errorMsg)) {
        console.warn(`[PublishQueue] High-risk category, arşivleniyor: ${payload.asin}`)
        await archivePoolItemForHighRisk(payload.workspaceId, payload.poolId).catch(() => undefined)
        return {
          poolId: payload.poolId,
          asin:   payload.asin,
          sku:    payload.sku,
          status: "failed",
          error:  errorMsg,
          durationMs: Date.now() - t0,
          guardScore: guard.score,
          guardErrors:   [],
          guardWarnings: guard.warnings,
        }
      }
      await markPoolAsPublishFailed(payload.poolId)
      return {
        poolId: payload.poolId,
        asin:   payload.asin,
        sku:    payload.sku,
        status: "failed",
        error:  errorMsg || "flow failed",
        durationMs: Date.now() - t0,
        guardScore: guard.score,
        guardErrors:   [],
        guardWarnings: guard.warnings,
      }
    }

    const inputs = zipPayloadsAndResults([payload], [flowResult])
    await persistPublishResults(inputs)

    return {
      poolId: payload.poolId,
      asin:   payload.asin,
      sku:    payload.sku,
      status: "success",
      error:  null,
      durationMs: Date.now() - t0,
      guardScore: guard.score,
      guardErrors:   [],
      guardWarnings: guard.warnings,
      ebayListingId: flowResult.ebayListingId ?? null,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isEbayHighRiskPoolDeleteError(msg)) {
      console.warn(`[PublishQueue] High-risk category, arşivleniyor: ${payload.asin}`)
      await archivePoolItemForHighRisk(payload.workspaceId, payload.poolId).catch(() => undefined)
    } else {
      console.error(`[PublishQueue] Skipping ${payload.asin}: ${msg}`)
      await markPoolAsPublishFailed(payload.poolId).catch(() => undefined)
      await markPoolAsSkipped(payload.poolId).catch(() => undefined)
    }
    return {
      poolId: payload.poolId,
      asin:   payload.asin,
      sku:    payload.sku,
      status: "failed",
      error:  msg,
      durationMs: Date.now() - t0,
      guardScore: guard.score,
      guardErrors:   [],
      guardWarnings: guard.warnings,
    }
  }
}

export async function runTimedPublishForStore(
  opts: TimedPublishOptions
): Promise<TimedPublishRunResult> {
  const {
    storeCode,
    storeId: preferredStoreId,
    workspaceId,
    delaySeconds,
    limit,
    dryRun,
    quantity,
    ebaySandbox,
    simulationMode,
    targetPoolIds,
    titleMode = "ai",
    source,
    archiveAvailabilityFailures = true,
    allowUnknownStockForDirectList = false,
  } = opts

  if (source === "scheduled_live_single_job") {
    if (!targetPoolIds || targetPoolIds.length !== 1) {
      throw new Error("scheduled live single job enforced: targetPoolIds must contain exactly 1 pool id")
    }
    console.log("[PublishQueue] scheduled live single job enforced (limit=1)")
  }

  const effectiveLimit = source === "scheduled_live_single_job" ? 1 : limit

  const startedAt = new Date().toISOString()
  const t0        = Date.now()

  console.log(
    `[PublishQueue] Starting | store=${storeCode} delay=${delaySeconds}s dryRun=${dryRun} titleMode=${titleMode}` +
      (targetPoolIds ? ` targetIds=${targetPoolIds.length}` : "")
  )

  const store = preferredStoreId != null && Number.isInteger(preferredStoreId) && preferredStoreId > 0
    ? await findStoreById(workspaceId, preferredStoreId)
    : await findStoreIdByCode(workspaceId, storeCode)
  if (!store) throw new Error("Store not found")
  if (store.status !== "active") {
    throw new Error(`Store not active: ${store.name?.trim() || "Store"}`)
  }

  const storeDisplayName = store.name?.trim() || "Store"

  const notifyListingDone = async (succeeded: number, failed: number) => {
    try {
      await addNotification(
        workspaceId,
        succeeded > 0 ? "success" : "error",
        "Listing Tamamlandı",
        `${succeeded} başarılı, ${failed} başarısız — ${storeDisplayName}`
      )
    } catch {
      /* bildirim ana akışı bozmasın */
    }
  }

  console.log(`[PublishQueue] Store: ${store.name} (id=${store.id})`)

  const storeSettings = await getSettingsByStore(workspaceId, store.id)
  console.log(
    `[PublishQueue] Settings: ${storeSettings ? `found (enabled=${storeSettings.enabled})` : "not found"}`
  )

  let payloads: EbayListingPayload[]

  if (targetPoolIds && targetPoolIds.length > 0) {
    const { splitEligiblePoolItems } = await import("../pool/poolEligibilityService")
    const split = await splitEligiblePoolItems(workspaceId, targetPoolIds)
    const eligibleTargetIds = split.eligibleIds

    if (eligibleTargetIds.length === 0) {
      await notifyListingDone(0, 0)
      return {
        storeId:     store.id,
        storeCode:   store.storeCode,
        storeName:   store.name,
        delaySeconds,
        dryRun,
        attempted:   0,
        succeeded:   0,
        failed:      0,
        skipped:     targetPoolIds.length,
        blocked:     0,
        items:       [],
        startedAt,
        completedAt: new Date().toISOString(),
        totalMs:     Date.now() - t0,
      }
    }

    if (split.skipDetails.length > 0) {
      console.warn(
        `[PublishQueue] ${split.skipDetails.length} poolId(s) skipped before payload build`
      )
    }

    payloads = await buildEbayListingPayloads(
      workspaceId,
      source === "scheduled_live_single_job" ? 1 : eligibleTargetIds.length * 3,
      eligibleTargetIds,
      { titleMode, publishStoreId: store.id, promotion: opts.promotion }
    )

    console.log(
      `[PublishQueue] TargetPoolIds mode: matched=${payloads.length}/${eligibleTargetIds.length}`
    )

    const matched = new Set(payloads.map(p => p.poolId))
    const missing = eligibleTargetIds.filter(id => !matched.has(id))
    if (missing.length > 0) {
      console.warn(
        `[PublishQueue] ${missing.length} poolId(s) not matched in payloads: ${missing.slice(0, 5).join(", ")}`
      )
    }
  } else {
    const queueEntries = await fetchPublishQueueForStore(workspaceId, store.id, effectiveLimit)
    console.log(`[PublishQueue] Queue: ${queueEntries.length} entries`)

    if (queueEntries.length === 0) {
      await notifyListingDone(0, 0)
      return {
        storeId:     store.id,
        storeCode:   store.storeCode,
        storeName:   store.name,
        delaySeconds,
        dryRun,
        attempted:   0,
        succeeded:   0,
        failed:      0,
        skipped:     0,
        blocked:     0,
        items:       [],
        startedAt,
        completedAt: new Date().toISOString(),
        totalMs:     Date.now() - t0,
      }
    }

    const allPayloads  = await buildEbayListingPayloads(workspaceId, effectiveLimit * 2, undefined, { titleMode })
    const queuePoolIds = new Set(queueEntries.map(e => e.poolId))
    payloads           = allPayloads.filter(p => queuePoolIds.has(p.poolId))
    console.log(`[PublishQueue] Payloads matched: ${payloads.length}/${queueEntries.length}`)
  }

  if (source === "scheduled_live_single_job" && payloads.length > 1) {
    payloads = payloads.filter(p => p.poolId === targetPoolIds![0]).slice(0, 1)
  }

  if (payloads.length > 0) {
    const archiveSkips: Array<{ poolId: number; asin: string; reason: string }> = []
    const filterOnly = new Set<number>()
    const seen = new Set<number>()
    for (const p of payloads) {
      if (!isAmazonAsin(p.asin) || seen.has(p.poolId)) continue
      seen.add(p.poolId)
      const availability = await evaluatePoolAmazonAvailability(workspaceId, p.poolId, p.asin)
      const skipReason = allowUnknownStockForDirectList
        ? resolveDirectListAvailabilitySkipReason(availability)
        : resolveAvailabilitySkipReason(availability)
      if (!skipReason) continue
      if (skipReason === "NOT_PRIME" || skipReason === "OUT_OF_STOCK" || skipReason === "PRIME_UNKNOWN"
        || skipReason === "LIMITED_STOCK" || skipReason === "STOCK_UNKNOWN") {
        archiveSkips.push({ poolId: p.poolId, asin: p.asin, reason: skipReason })
      } else {
        filterOnly.add(p.poolId)
        console.log(`[PublishQueue] Availability skip (no archive): poolId=${p.poolId} reason=${skipReason}`)
      }
    }
    if (archiveSkips.length > 0) {
      if (archiveAvailabilityFailures) {
        await processAvailabilityArchiveSkip(workspaceId, archiveSkips)
      } else {
        console.log("[PublishQueue] Availability skip (Direct List; no archive): " + archiveSkips.length)
      }
      const archivedSet = new Set(archiveSkips.map(e => e.poolId))
      payloads = payloads.filter(p => !archivedSet.has(p.poolId))
    }
    if (filterOnly.size > 0) {
      payloads = payloads.filter(p => !filterOnly.has(p.poolId))
    }
    if (archiveSkips.length > 0 || filterOnly.size > 0) {
      console.log(
        `[PublishQueue] Availability filter: archived=${archiveSkips.length} filtered_unknown=${filterOnly.size} remaining=${payloads.length}`
      )
    }
  }

  const quantityOverride =
    typeof quantity === "number" && Number.isInteger(quantity) && quantity >= 1 ? quantity : null
  console.log(`[PublishQueue] quantityOverride=${quantityOverride} (raw quantity=${quantity})`)
  if (quantityOverride !== null && payloads.length > 0) {
    payloads = payloads.map(p => ({ ...p, quantity: quantityOverride }))
  }

  if (payloads.length === 0) {
    console.log(`[PublishQueue] No payloads to process`)
    await notifyListingDone(0, 0)
    return {
      storeId:     store.id,
      storeCode:   store.storeCode,
      storeName:   store.name,
      delaySeconds,
      dryRun,
      attempted:   0,
      succeeded:   0,
      failed:      0,
      skipped:     0,
      blocked:     0,
      items:       [],
      startedAt,
      completedAt: new Date().toISOString(),
      totalMs:     Date.now() - t0,
    }
  }

  const ebayFlowOpts: InventoryFlowClientOptions = {
    sandbox:        ebaySandbox,
    simulationMode,
    titleMode,
    workspaceId,
    storeId:        store.id,
  }

  const items: PublishItemResult[] = []
  let succeeded = 0
  let failed    = 0
  let skipped   = 0
  let blocked   = 0

  for (let i = 0; i < payloads.length; i++) {
    if (source === "scheduled_live_single_job" && i > 0) break
    const payload = payloads[i]
    console.log(`[PublishQueue] [${i + 1}/${payloads.length}] ASIN=${payload.asin} SKU=${payload.sku}`)

    let result: PublishItemResult
    try {
      result = await publishOne(payload, storeSettings, ebayFlowOpts, dryRun)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isEbayHighRiskPoolDeleteError(msg)) {
        console.warn(`[PublishQueue] High-risk category, arşivleniyor: ${payload.asin}`)
        await archivePoolItemForHighRisk(payload.workspaceId, payload.poolId).catch(() => undefined)
      } else {
        console.error(`[PublishQueue] Skipping ${payload.asin}: ${msg}`)
        await markPoolAsSkipped(payload.poolId).catch(() => undefined)
      }
      result = {
        poolId:        payload.poolId,
        asin:          payload.asin,
        sku:           payload.sku,
        status:        "failed",
        error:         msg,
        durationMs:    0,
        guardScore:    null,
        guardErrors:   [],
        guardWarnings: [],
      }
    }

    items.push(result)

    if      (result.status === "success") succeeded++
    else if (result.status === "failed")  failed++
    else if (result.status === "blocked") blocked++
    else                                   skipped++

    const shouldDelay =
      i < payloads.length - 1 && delaySeconds > 0 && !dryRun && result.status !== "blocked"
    if (shouldDelay) {
      console.log(`[PublishQueue] Waiting ${delaySeconds}s...`)
      await sleep(delaySeconds * 1000)
    }
  }

  const completedAt = new Date().toISOString()
  console.log(
    `[PublishQueue] Done | attempted=${payloads.length} succeeded=${succeeded} failed=${failed} blocked=${blocked} skipped=${skipped}`
  )

  await notifyListingDone(succeeded, failed)

  return {
    storeId:     store.id,
    storeCode:   store.storeCode,
    storeName:   store.name,
    delaySeconds,
    dryRun,
    attempted:   payloads.length,
    succeeded,
    failed,
    skipped,
    blocked,
    items,
    startedAt,
    completedAt,
    totalMs:     Date.now() - t0,
  }
}
