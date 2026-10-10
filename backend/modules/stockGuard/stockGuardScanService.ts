import { query } from "../../db/client"
import { loadKeepaConfig } from "../keepa/keepaClient"
import { keepaCheckAsins } from "../keepa/keepaDecisionService"
import { isTrustedCurrentKeepaPriceSource } from "../keepa/keepaPriceTypes"
import { resolveListingAsin } from "../monitor/monitorService"
import { addNotification } from "../notifications/notificationService"
import { upsertPendingReviewItem } from "../stockAlerts/stockAlertsRepository"
import {
  PRICE_UNCERTAIN_GENERIC,
  formatPriceIncreasePendingReason,
} from "../stockAlerts/stockAlertUserMessages"
import type { ApproveZeroJobItem } from "../stockAlerts/stockAlertsApproveZeroWorker"
import { runAutoProfitProtectionPass } from "./autoProfitProtectionService"
import { autoZeroCatalogListing, notifyAutoZeroed } from "./stockGuardAutoActionService"
import type { StockGuardSettingsRow } from "./stockGuardTypes"
import type { CatalogSourceStatus, SourceCheckPriority } from "./stockGuardTypes"
import {
  STOCK_GUARD_DUE_CATALOG_WHERE,
} from "./stockGuardDueFinder"
import {
  countSkippedZeroQty,
  isEligibleForStockGuardScan,
  STOCK_GUARD_DUE_ORDER_BY,
  STOCK_GUARD_MAX_DUE_ASINS_PER_JOB,
} from "./stockGuardScanEligibility"
import { RISK_STATUSES } from "./stockGuardTypes"

type StoreRow = { id: number; store_code: string; name: string }

type CandidateRow = {
  id: number
  internal_sku: string
  source_url: string | null
  registry_asin: string | null
  ebay_item_id: string | null
  ebay_title: string | null
  image_url: string | null
  ebay_quantity: number | null
  ebay_price: string | null
  source_price: string | null
  source_status: string | null
  source_risk_seen_count: number
  total_sold: number | null
  sold_30d: number | null
  clicks_30d: number | null
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function computePriority(row: CandidateRow): SourceCheckPriority {
  const sold = (row.total_sold ?? 0) > 0 || (row.sold_30d ?? 0) > 0
  if (sold) return "sold"
  const clicks = row.clicks_30d
  if (clicks != null && clicks > 0) return "clicked"
  return "normal"
}

function hoursForPriority(p: SourceCheckPriority, settings: StockGuardSettingsRow): number {
  if (p === "sold") return settings.soldScanHours
  if (p === "clicked") return settings.clickedScanHours
  return settings.normalScanHours
}

function detectPriceIncrease(
  previous: number | null,
  next: number | null,
  settings: StockGuardSettingsRow
): { increase: boolean; percent: number | null; diff: number | null } {
  if (previous == null || next == null || previous <= 0) {
    return { increase: false, percent: null, diff: null }
  }
  const diff = next - previous
  const percent = (diff / previous) * 100
  if (diff <= 0) return { increase: false, percent, diff }
  const ok =
    diff >= settings.priceIncreaseAmountThreshold ||
    percent >= settings.priceIncreasePercentThreshold
  return { increase: ok, percent: Math.round(percent * 100) / 100, diff }
}

/** Explicit casts — avoids PostgreSQL "could not determine data type of parameter $N". */
async function updateCatalogAfterKeepaCheck(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
  finalStatus: string
  reason: string
  newPrice: number | null
  selectedPriceSource?: string | null
  priority: SourceCheckPriority
  scanHours: number
}): Promise<void> {
  const op = "updateCatalogAfterKeepaCheck"
  const preservePrice = input.finalStatus === "PRICE_UNCERTAIN" || input.finalStatus === "CHECK_FAILED"
  const priceSource =
    input.selectedPriceSource && input.selectedPriceSource !== "NONE"
      ? input.selectedPriceSource
      : null
  try {
    await query(
      `UPDATE store_catalog_state
       SET source_previous_price = source_price,
           source_last_price = source_price,
           source_last_status = source_status,
           source_status = $1::text,
           source_status_reason = $2::text,
           source_price = CASE WHEN $9::boolean THEN source_price ELSE $3::numeric END,
           source_price_source = CASE
             WHEN $9::boolean THEN source_price_source
             WHEN $3::numeric IS NOT NULL AND $10::text IS NOT NULL THEN $10::text
             ELSE source_price_source
           END,
           source_checked_at = NOW(),
           source_price_changed_at = CASE
             WHEN $9::boolean THEN source_price_changed_at
             WHEN $3::numeric IS NOT NULL AND source_price IS DISTINCT FROM $3::numeric THEN NOW()
             ELSE source_price_changed_at
           END,
           source_risk_seen_count = CASE
             WHEN $1::text = 'AMAZON_OK' THEN 0
             WHEN $1::text IN ('NO_PRICE','UNAVAILABLE','REMOVED','PRICE_UNCERTAIN') THEN COALESCE(source_risk_seen_count, 0) + 1
             ELSE source_risk_seen_count
           END,
           source_check_priority = $4::text,
           source_next_check_at = NOW() + make_interval(hours => $5::int),
           updated_at = NOW()
       WHERE workspace_id = $6::uuid AND store_id = $7::bigint AND id = $8::bigint`,
      [
        input.finalStatus,
        input.reason,
        input.newPrice,
        input.priority,
        input.scanHours,
        input.workspaceId,
        input.storeId,
        input.catalogStateId,
        preservePrice,
        priceSource,
      ]
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(
      `[StockGuard][SQL] ${op} failed catalogStateId=${input.catalogStateId} storeId=${input.storeId} params=8 error=${msg}`
    )
    throw new Error(`${op}: ${msg}`)
  }
}

async function loadDueCandidates(
  workspaceId: string,
  storeId: number
): Promise<CandidateRow[]> {
  const res = await query<CandidateRow>(
    `SELECT scs.id,
            scs.internal_sku,
            scs.source_url,
            ar.asin AS registry_asin,
            scs.ebay_item_id,
            scs.ebay_title,
            scs.image_url,
            scs.ebay_quantity,
            scs.ebay_price::text AS ebay_price,
            scs.source_price::text AS source_price,
            scs.source_status,
            COALESCE(scs.source_risk_seen_count, 0) AS source_risk_seen_count,
            scs.total_sold,
            scs.sold_30d,
            scs.clicks_30d
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND scs.store_id = $2::bigint
       AND ${STOCK_GUARD_DUE_CATALOG_WHERE}
     ORDER BY ${STOCK_GUARD_DUE_ORDER_BY}
     LIMIT $3::int`,
    [workspaceId, storeId, STOCK_GUARD_MAX_DUE_ASINS_PER_JOB]
  )
  return res.rows
}

async function getStore(workspaceId: string, storeId: number): Promise<StoreRow | null> {
  const res = await query<StoreRow>(
    `SELECT id, store_code, name FROM stores
     WHERE workspace_id = $1::uuid AND id = $2::bigint AND status = 'active' LIMIT 1`,
    [workspaceId, storeId]
  )
  return res.rows[0] ?? null
}

export type ScanJobResult = {
  scanned: number
  risks: number
  reviewCreated: number
  autoZeroed: number
  priceAlerts: number
  skippedZeroQty: number
}

export async function runStockGuardScanJob(input: {
  workspaceId: string
  storeId: number
  settings: StockGuardSettingsRow
  jobId?: number
}): Promise<ScanJobResult> {
  const cfg = loadKeepaConfig()
  if (!cfg.enabled || !cfg.apiKey) {
    throw new Error("Keepa is disabled or API key missing")
  }

  const store = await getStore(input.workspaceId, input.storeId)
  if (!store) throw new Error("Store not found")

  const settings: StockGuardSettingsRow = {
    ...input.settings,
    enabled: true,
    mode: "auto",
    priceAlertEnabled: true,
    autoProfitProtectionEnabled: true,
  }

  console.log(
    `[StockGuardScan] start store=${store.store_code} store_id=${input.storeId} jobId=${input.jobId ?? "n/a"}`
  )

  const skippedZeroQty = await countSkippedZeroQty(input.workspaceId, input.storeId)
  const rows = await loadDueCandidates(input.workspaceId, input.storeId)
  const asinToIds = new Map<string, number[]>()
  const asinToRows = new Map<string, CandidateRow[]>()
  let skippedNoAsin = 0

  for (const r of rows) {
    const asin = resolveListingAsin({
      registryAsin: r.registry_asin,
      sourceUrl: r.source_url,
      internalSku: r.internal_sku?.trim() ?? "",
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
  let reviewCreated = 0
  let risks = 0
  let autoZeroed = 0
  let priceAlerts = 0

  console.log(
    `[StockGuardScan] store=${store.store_code} dueListings=${rows.length} uniqueAsins=${uniqueAsins.length} skippedNoAsin=${skippedNoAsin} skippedZeroQty=${skippedZeroQty}`
  )

  const storeBatches = chunk(uniqueAsins, 100)
  for (let bi = 0; bi < storeBatches.length; bi++) {
    const batch = storeBatches[bi]!
    for (const c of chunk(batch, 20)) {
      const decisions = await keepaCheckAsins(c, input.workspaceId)
      for (const d of decisions) {
        const ids = asinToIds.get(d.asin) ?? []
        const catalogRows = asinToRows.get(d.asin) ?? []

        for (const row of catalogRows) {
          if (!isEligibleForStockGuardScan(row.ebay_quantity)) continue

          const prevRaw = row.source_price?.trim()
          const previousPrice =
            prevRaw != null && prevRaw !== "" ? parseFloat(prevRaw) : null
          const prevFinite = previousPrice != null && Number.isFinite(previousPrice)
            ? previousPrice
            : null

          let priceInc: { oldPrice: number; newPrice: number; percent: number | null } | null =
            null
          if (
            settings.priceAlertEnabled &&
            d.sourceStatus === "AMAZON_OK" &&
            isTrustedCurrentKeepaPriceSource(d.selectedPriceSource) &&
            prevFinite != null &&
            d.price != null
          ) {
            const det = detectPriceIncrease(prevFinite, d.price, input.settings)
            if (det.increase && det.diff != null) {
              priceInc = {
                oldPrice: prevFinite,
                newPrice: d.price,
                percent: det.percent,
              }
            }
          }

          const priority = computePriority(row)
          const hours = hoursForPriority(priority, settings)

          let finalStatus: CatalogSourceStatus =
            d.sourceStatus === "PRICE_UNCERTAIN"
              ? "PRICE_UNCERTAIN"
              : (d.sourceStatus as CatalogSourceStatus)
          if (priceInc && !input.settings.autoProfitProtectionEnabled) {
            finalStatus = "PRICE_INCREASE"
          }

          await updateCatalogAfterKeepaCheck({
            workspaceId: input.workspaceId,
            storeId: input.storeId,
            catalogStateId: row.id,
            finalStatus,
            reason: priceInc ? "Amazon price increased" : d.reason,
            newPrice: d.sourceStatus === "PRICE_UNCERTAIN" ? null : d.price,
            selectedPriceSource: d.selectedPriceSource,
            priority,
            scanHours: hours,
          })

          const isRisk = RISK_STATUSES.includes(finalStatus)
          if (!isRisk) continue
          risks++

          const autoItem: ApproveZeroJobItem = {
            id: row.id,
            catalogStateId: row.id,
            internalSku: row.internal_sku?.trim() || null,
            ebayItemId: row.ebay_item_id?.trim() || null,
            ebayOfferId: null,
            sourceStatus: finalStatus,
            sourceStatusReason: priceInc ? "Amazon price increased" : d.reason,
          }

          if (finalStatus === "PRICE_UNCERTAIN") {
            const action = await upsertPendingReviewItem({
              workspaceId: input.workspaceId,
              storeId: input.storeId,
              catalogStateId: row.id,
              ebayItemId: row.ebay_item_id?.trim() || null,
              internalSku: row.internal_sku?.trim() || null,
              asin: d.asin,
              ebayTitle: row.ebay_title?.trim() || null,
              imageUrl: row.image_url?.trim() || null,
              ebayQuantity: row.ebay_quantity ?? null,
              ebayPrice:
                row.ebay_price != null && row.ebay_price.trim() !== ""
                  ? parseFloat(row.ebay_price)
                  : null,
              sourceStatus: "PRICE_UNCERTAIN",
              sourceStatusReason: PRICE_UNCERTAIN_GENERIC,
              sourcePrice: null,
            })
            if (action === "created") reviewCreated++
            continue
          }

          if (finalStatus === "PRICE_INCREASE") {
            const action = await upsertPendingReviewItem({
              workspaceId: input.workspaceId,
              storeId: input.storeId,
              catalogStateId: row.id,
              ebayItemId: row.ebay_item_id?.trim() || null,
              internalSku: row.internal_sku?.trim() || null,
              asin: d.asin,
              ebayTitle: row.ebay_title?.trim() || null,
              imageUrl: row.image_url?.trim() || null,
              ebayQuantity: row.ebay_quantity ?? null,
              ebayPrice:
                row.ebay_price != null && row.ebay_price.trim() !== ""
                  ? parseFloat(row.ebay_price)
                  : null,
              sourceStatus: "PRICE_INCREASE",
              sourceStatusReason:
                priceInc != null
                  ? formatPriceIncreasePendingReason(priceInc.oldPrice, priceInc.newPrice)
                  : "Amazon price increased",
              sourcePrice: d.price,
              oldSourcePrice: priceInc?.oldPrice ?? null,
              newSourcePrice: priceInc?.newPrice ?? null,
              priceChangePercent: priceInc?.percent ?? null,
            })
            if (action === "created") reviewCreated++
            if (action) priceAlerts++
            continue
          }

          if (d.sourceStatus === "CHECK_FAILED") continue

          let doAuto = false
          if (settings.mode === "auto" && settings.enabled) {
            if (finalStatus === "REMOVED" || finalStatus === "UNAVAILABLE") {
              doAuto = true
            } else if (finalStatus === "NO_PRICE") {
              const prevSeen = row.source_risk_seen_count ?? 0
              if (
                !settings.autoZeroNoPriceRequiresRepeat ||
                prevSeen >= 1
              ) {
                doAuto = true
              }
            }
          }

          if (doAuto) {
            const result = await autoZeroCatalogListing({
              workspaceId: input.workspaceId,
              storeId: input.storeId,
              storeCode: store.store_code,
              storeName: store.name,
              item: autoItem,
              reason: d.reason,
            })
            if (result === "ACTIONED" || result === "SIMULATION") autoZeroed++
            continue
          }

          const action = await upsertPendingReviewItem({
            workspaceId: input.workspaceId,
            storeId: input.storeId,
            catalogStateId: row.id,
            ebayItemId: row.ebay_item_id?.trim() || null,
            internalSku: row.internal_sku?.trim() || null,
            asin: d.asin,
            ebayTitle: row.ebay_title?.trim() || null,
            imageUrl: row.image_url?.trim() || null,
            ebayQuantity: row.ebay_quantity ?? null,
            ebayPrice:
              row.ebay_price != null && row.ebay_price.trim() !== ""
                ? parseFloat(row.ebay_price)
                : null,
            sourceStatus: finalStatus,
            sourceStatusReason: d.reason,
            sourcePrice: d.price,
          })
          if (action === "created") reviewCreated++
        }
      }
      await sleep(150)
    }
    if (bi < storeBatches.length - 1) await sleep(500)
  }

  if (reviewCreated > 0 && settings.mode === "manual") {
    void addNotification(
      input.workspaceId,
      "warning",
      reviewCreated === 1
        ? "1 product needs stock review"
        : `${reviewCreated} products need stock review`,
      `Store: ${store.name}`
    )
  }
  if (priceAlerts > 0) {
    void addNotification(
      input.workspaceId,
      "warning",
      priceAlerts === 1
        ? "1 product has an Amazon price increase"
        : `${priceAlerts} products have Amazon price increases`,
      `Store: ${store.name}`
    )
  }
  if (autoZeroed > 0) {
    await notifyAutoZeroed(input.workspaceId, store.name, autoZeroed)
  }

  await runAutoProfitProtectionPass({
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    storeCode: store.store_code,
    storeName: store.name,
    settings,
  })

  return {
    scanned: uniqueAsins.length,
    risks,
    reviewCreated,
    autoZeroed,
    priceAlerts,
    skippedZeroQty,
  }
}
