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
  findStoreIdByCode,
  markPoolAsPublishFailed,
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
import { getSettingsByStore } from "../storeSettings/storeSettingsRepository"
import { runPublishGuard } from "../publishGuard/publishGuardService"
import type { StoreSettingsRow } from "../storeSettings/storeSettingsTypes"
import type {
  PublishItemResult,
  TimedPublishOptions,
  TimedPublishRunResult,
} from "./publishQueueTypes"

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
    const alreadyLive = await query<{ id: number }>(
      `SELECT lh.id FROM listing_history lh
   INNER JOIN asin_registry ar ON ar.id = lh.asin_registry_id
   WHERE lh.workspace_id = $1
     AND lh.store_id = $2
     AND ar.asin = $3
     AND lh.status = 'live'
   LIMIT 1`,
      [payload.workspaceId, payload.storeId, payload.asin]
    )

    if (alreadyLive.rows.length > 0) {
      console.log(`  [Guard] SKIP: ${payload.asin} already live in store`)
      return {
        poolId: payload.poolId,
        asin: payload.asin,
        sku: payload.sku,
        status: "skipped",
        error: null,
        durationMs: Date.now() - t0,
        guardScore: null,
        guardErrors: [],
        guardWarnings: ["Already live in this store"],
      }
    }

    const flowResult = await runInventoryFlow(payload, ebayFlowOpts)
    const didFail =
      flowResult.inventoryItemStatus === "failed" || flowResult.inventoryItemStatus === "FAILED" ||
      flowResult.offerStatus         === "failed" || flowResult.offerStatus         === "FAILED" ||
      flowResult.publishStatus       === "failed" || flowResult.publishStatus       === "FAILED"

    if (didFail) {
      await markPoolAsPublishFailed(payload.poolId)
      return {
        poolId: payload.poolId,
        asin:   payload.asin,
        sku:    payload.sku,
        status: "failed",
        error:  flowResult.error ?? "flow failed",
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
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markPoolAsPublishFailed(payload.poolId).catch(() => undefined)
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
    workspaceId,
    delaySeconds,
    limit,
    dryRun,
    quantity,
    ebaySandbox,
    simulationMode,
    targetPoolIds,
  } = opts

  const startedAt = new Date().toISOString()
  const t0        = Date.now()

  console.log(
    `[PublishQueue] Starting | store=${storeCode} delay=${delaySeconds}s dryRun=${dryRun}` +
      (targetPoolIds ? ` targetIds=${targetPoolIds.length}` : "")
  )

  const store = await findStoreIdByCode(workspaceId, storeCode)
  if (!store) throw new Error(`Store not found: storeCode="${storeCode}"`)
  if (store.status !== "active") throw new Error(`Store not active: "${storeCode}"`)

  console.log(`[PublishQueue] Store: ${store.name} (id=${store.id})`)

  const storeSettings = await getSettingsByStore(workspaceId, store.id)
  console.log(
    `[PublishQueue] Settings: ${storeSettings ? `found (enabled=${storeSettings.enabled})` : "not found"}`
  )

  let payloads: EbayListingPayload[]

  if (targetPoolIds && targetPoolIds.length > 0) {
    const fetchLimit = Math.max(targetPoolIds.length * 3, 100)
    const all        = await buildEbayListingPayloads(workspaceId, fetchLimit)
    const idSet      = new Set(targetPoolIds)
    payloads         = all.filter(p => idSet.has(p.poolId))

    console.log(
      `[PublishQueue] TargetPoolIds mode: fetched=${all.length} matched=${payloads.length}/${targetPoolIds.length}`
    )

    const matched = new Set(payloads.map(p => p.poolId))
    const missing = targetPoolIds.filter(id => !matched.has(id))
    if (missing.length > 0) {
      console.warn(
        `[PublishQueue] ${missing.length} poolId(s) not matched in payloads: ${missing.slice(0, 5).join(", ")}`
      )
    }
  } else {
    const queueEntries = await fetchPublishQueueForStore(workspaceId, store.id, limit)
    console.log(`[PublishQueue] Queue: ${queueEntries.length} entries`)

    if (queueEntries.length === 0) {
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

    const allPayloads  = await buildEbayListingPayloads(workspaceId, limit * 2)
    const queuePoolIds = new Set(queueEntries.map(e => e.poolId))
    payloads           = allPayloads.filter(p => queuePoolIds.has(p.poolId))
    console.log(`[PublishQueue] Payloads matched: ${payloads.length}/${queueEntries.length}`)
  }

  const quantityOverride =
    typeof quantity === "number" && Number.isInteger(quantity) && quantity >= 1 ? quantity : null
  if (quantityOverride !== null && payloads.length > 0) {
    payloads = payloads.map(p => ({ ...p, quantity: quantityOverride }))
  }

  if (payloads.length === 0) {
    console.log(`[PublishQueue] No payloads to process`)
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
  }

  const items: PublishItemResult[] = []
  let succeeded = 0
  let failed    = 0
  let skipped   = 0
  let blocked   = 0

  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i]
    console.log(`[PublishQueue] [${i + 1}/${payloads.length}] ASIN=${payload.asin} SKU=${payload.sku}`)

    const result = await publishOne(payload, storeSettings, ebayFlowOpts, dryRun)
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
