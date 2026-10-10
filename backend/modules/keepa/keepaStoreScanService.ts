import { query } from "../../db/client"
import { resolveListingAsin } from "../monitor/monitorService"
import { loadKeepaConfig } from "./keepaClient"
import { keepaCheckAsins } from "./keepaDecisionService"
import type { KeepaScanStoreResponse, KeepaSourceStatus } from "./keepaTypes"
import { upsertPendingReviewItem } from "../stockAlerts/stockAlertsRepository"
import { PRICE_UNCERTAIN_GENERIC } from "../stockAlerts/stockAlertUserMessages"
import {
  countSkippedZeroQty,
  isEligibleForStockGuardScan,
  STOCK_GUARD_SCAN_ELIGIBLE_QTY,
} from "../stockGuard/stockGuardScanEligibility"
import { runForStoreAfterSourceScan } from "../stockGuard/autoProfitProtectionService"

type StoreRow = { id: number; name: string }

type CandidateRow = {
  id:           number
  internal_sku: string
  source_url:   string | null
  registry_asin: string | null
  ebay_item_id: string | null
  ebay_title: string | null
  image_url: string | null
  ebay_quantity: number | null
  ebay_price: string | null
}

async function getStoreByCode(
  workspaceId: string,
  storeCode:   string
): Promise<StoreRow | null> {
  const result = await query<StoreRow>(
    `SELECT id, name FROM stores
     WHERE workspace_id = $1 AND store_code = $2 AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  return result.rows[0] ?? null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function emptyCounts() {
  return {
    amazonOk: 0,
    noPrice: 0,
    unavailable: 0,
    removed: 0,
    checkFailed: 0,
    priceUncertain: 0,
    primeExclusiveUsed: 0,
    buyBoxUsed: 0,
    newUsed: 0,
  }
}

function bump(counts: ReturnType<typeof emptyCounts>, status: KeepaSourceStatus): void {
  switch (status) {
    case "AMAZON_OK":
      counts.amazonOk++
      break
    case "NO_PRICE":
      counts.noPrice++
      break
    case "UNAVAILABLE":
      counts.unavailable++
      break
    case "REMOVED":
      counts.removed++
      break
    case "PRICE_UNCERTAIN":
      counts.priceUncertain++
      break
    case "CHECK_FAILED":
      counts.checkFailed++
      break
    default:
      counts.checkFailed++
      break
  }
}

function bumpPriceSourceUsage(
  counts: ReturnType<typeof emptyCounts>,
  source: string
): void {
  if (source === "PRIME_EXCLUSIVE_CURRENT") counts.primeExclusiveUsed++
  else if (source === "BUY_BOX_CURRENT") counts.buyBoxUsed++
  else if (source === "NEW_CURRENT" || source === "NEW_FBA_CURRENT") counts.newUsed++
}

async function loadCandidates(
  workspaceId: string,
  storeId:     number
): Promise<CandidateRow[]> {
  const result = await query<CandidateRow>(
    `SELECT scs.id,
            scs.internal_sku,
            scs.source_url,
            ar.asin AS registry_asin,
            scs.ebay_item_id,
            scs.ebay_title,
            scs.image_url,
            scs.ebay_quantity,
            scs.ebay_price::text AS ebay_price
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1
       AND scs.store_id = $2
       AND scs.panel_hidden_at IS NULL
       AND scs.current_status = 'live'
       AND COALESCE(scs.stock_guard_enabled, true) = true
       AND ${STOCK_GUARD_SCAN_ELIGIBLE_QTY}`,
    [workspaceId, storeId]
  )
  return result.rows
}

async function updateRowsForAsin(
  workspaceId: string,
  storeId:     number,
  ids:         number[],
  decision:    {
    sourceStatus: KeepaSourceStatus
    reason: string
    price: number | null
    selectedPriceSource: string
  }
): Promise<number> {
  if (ids.length === 0) return 0
  const preservePrice = decision.sourceStatus === "PRICE_UNCERTAIN" || decision.sourceStatus === "CHECK_FAILED"
  const priceSource =
    decision.sourceStatus === "PRICE_UNCERTAIN"
      ? "PRICE_UNCERTAIN"
      : decision.selectedPriceSource !== "NONE" && decision.selectedPriceSource !== "PRICE_UNCERTAIN"
        ? decision.selectedPriceSource
        : null
  const result = await query(
    `UPDATE store_catalog_state
     SET source_status = $1,
         source_status_reason = $2,
         source_price = CASE WHEN $7::boolean THEN source_price ELSE $3::numeric END,
         source_price_source = CASE
           WHEN $7::boolean THEN source_price_source
           WHEN $3::numeric IS NOT NULL AND $8::text IS NOT NULL THEN $8::text
           ELSE source_price_source
         END,
         source_checked_at = NOW(),
         updated_at = NOW()
     WHERE workspace_id = $4
       AND store_id = $5
       AND id = ANY($6::bigint[])`,
    [
      decision.sourceStatus,
      decision.reason,
      decision.price,
      workspaceId,
      storeId,
      ids,
      preservePrice,
      priceSource,
    ]
  )
  return result.rowCount ?? 0
}

export async function scanStoreSourcesWithKeepa(
  workspaceId: string,
  storeCodeRaw: string
): Promise<KeepaScanStoreResponse> {
  const cfg = loadKeepaConfig()
  if (!cfg.enabled) {
    throw new Error("Keepa is disabled")
  }
  if (!cfg.apiKey) {
    throw new Error("Keepa API key missing")
  }

  const storeCode = storeCodeRaw.trim()
  if (!storeCode) throw new Error("storeCode is required")

  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error("Active store not found")

  const skippedZeroQty = await countSkippedZeroQty(workspaceId, store.id)
  const rows = await loadCandidates(workspaceId, store.id)

  const asinToIds = new Map<string, number[]>()
  const asinToRows = new Map<string, CandidateRow[]>()
  let skippedNoAsin = 0

  for (const r of rows) {
    const asin = resolveListingAsin({
      registryAsin: r.registry_asin,
      sourceUrl:    r.source_url,
      internalSku:  r.internal_sku?.trim() ?? "",
    })
    if (!asin) {
      skippedNoAsin++
      continue
    }
    const list = asinToIds.get(asin) ?? []
    list.push(r.id)
    asinToIds.set(asin, list)

    const rr = asinToRows.get(asin) ?? []
    rr.push(r)
    asinToRows.set(asin, rr)
  }

  const uniqueAsins = [...asinToIds.keys()]
  const scannedCatalogStateIds = rows.map(r => r.id)
  const counts = emptyCounts()

  let updated = 0
  const scanned = uniqueAsins.length
  let reviewCreated = 0
  let reviewUpdated = 0
  let riskPending = 0

  console.log(
    `[KeepaScanStore] start storeCode=${storeCode} store_id=${store.id} uniqueAsins=${uniqueAsins.length} candidates=${rows.length} skippedNoAsin=${skippedNoAsin} skippedZeroQty=${skippedZeroQty}`
  )

  // Process in 100-asin “store batches”, within each call Keepa in <=20 chunks.
  const storeBatches = chunk(uniqueAsins, 100)
  for (let i = 0; i < storeBatches.length; i++) {
    const batch = storeBatches[i]!
    const keepaChunks = chunk(batch, 20)

    for (const c of keepaChunks) {
      const decisions = await keepaCheckAsins(c, workspaceId)
      for (const d of decisions) {
        bump(counts, d.sourceStatus)
        if (d.sourceStatus === "AMAZON_OK") {
          bumpPriceSourceUsage(counts, d.selectedPriceSource)
        }
        const ids = asinToIds.get(d.asin) ?? []
        updated += await updateRowsForAsin(workspaceId, store.id, ids, {
          sourceStatus: d.sourceStatus,
          reason: d.reason,
          price: d.price,
          selectedPriceSource: d.selectedPriceSource,
        })

        const risky =
          d.sourceStatus === "NO_PRICE" ||
          d.sourceStatus === "UNAVAILABLE" ||
          d.sourceStatus === "REMOVED" ||
          d.sourceStatus === "PRICE_UNCERTAIN"
        if (risky) {
          const rr = asinToRows.get(d.asin) ?? []
          for (const row of rr) {
            if (!isEligibleForStockGuardScan(row.ebay_quantity)) continue
            const action = await upsertPendingReviewItem({
              workspaceId,
              storeId: store.id,
              catalogStateId: row.id,
              ebayItemId: row.ebay_item_id?.trim() || null,
              internalSku: row.internal_sku?.trim() || null,
              asin: d.asin,
              ebayTitle: row.ebay_title?.trim() || null,
              imageUrl: row.image_url?.trim() || null,
              ebayQuantity: row.ebay_quantity ?? null,
              ebayPrice: row.ebay_price != null && row.ebay_price.trim() !== "" ? parseFloat(row.ebay_price) : null,
              sourceStatus: d.sourceStatus,
              sourceStatusReason:
                d.sourceStatus === "PRICE_UNCERTAIN" ? PRICE_UNCERTAIN_GENERIC : d.reason,
              sourcePrice: d.price,
            })
            if (!action) continue
            if (action === "created") reviewCreated++
            else reviewUpdated++
            riskPending++
          }
        }
      }
      // tiny delay to be gentle with rate limits
      await sleep(150)
    }

    // small delay between 100-asin batches
    if (i < storeBatches.length - 1) await sleep(500)
  }

  const autoProfit = await runForStoreAfterSourceScan({
    workspaceId,
    storeCode,
    catalogStateIds: scannedCatalogStateIds,
  })

  console.log(
    `[KeepaScanStore] done storeCode=${storeCode} store_id=${store.id} scanned=${scanned} updated=${updated} amazonOk=${counts.amazonOk} primeExclusiveUsed=${counts.primeExclusiveUsed} buyBoxUsed=${counts.buyBoxUsed} newUsed=${counts.newUsed} priceUncertain=${counts.priceUncertain} noPrice=${counts.noPrice} unavailable=${counts.unavailable} removed=${counts.removed} checkFailed=${counts.checkFailed} autoPriceProtected=${autoProfit.updated}`
  )

  return {
    ok: true,
    storeCode,
    queued: false,
    scanned,
    updated,
    skippedNoAsin,
    skippedZeroQty,
    reviewCreated,
    reviewUpdated,
    riskPending,
    amazonOk: counts.amazonOk,
    noPrice: counts.noPrice,
    unavailable: counts.unavailable,
    removed: counts.removed,
    checkFailed: counts.checkFailed,
    priceUncertain: counts.priceUncertain,
    primeExclusiveUsed: counts.primeExclusiveUsed,
    buyBoxUsed: counts.buyBoxUsed,
    newUsed: counts.newUsed,
    autoPriceProtected: autoProfit.updated,
    autoPriceSkipped: autoProfit.skipped,
    autoPriceSafetyBlocked: 0,
    autoPriceFailed: autoProfit.failed,
  }
}

