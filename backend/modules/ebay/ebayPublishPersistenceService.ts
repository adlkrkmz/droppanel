// ─────────────────────────────────────────────────────────────
// ebayPublishPersistenceService.ts
//
// Başarılı eBay publish sonuçlarını DB'ye yazar:
//   1. asin_pool           → status / listing_status / pipeline_stage
//   2. listing_history     → insert (idempotent on store_id + ebay_item_id)
//   3. store_catalog_state → upsert ON CONFLICT (store_id, asin_registry_id)
//
// workspace_id : payload.workspaceId (exact publish workspace — never env WORKSPACE_ID)
// store_id     : payload.assignedStoreId
// ─────────────────────────────────────────────────────────────

import { query } from "../../db/client"
import type { InventoryFlowResult } from "./ebayApiTypes"
import type { EbayListingPayload } from "./ebayPayloadService"

function resolvePersistWorkspaceId(payload: EbayListingPayload): string {
  const id = String(payload.workspaceId ?? "").trim()
  if (!id) throw new Error("payload.workspaceId is required for publish persistence")
  return id
}

// ─── TİPLER ───────────────────────────────────────────────────

export type PersistenceInput = {
  result:  InventoryFlowResult
  payload: EbayListingPayload
}

export type PersistenceRowResult = {
  poolId:            number
  asin:              string
  sku:               string
  persisted:         boolean
  poolUpdated:       boolean
  listingHistoryId:  number | null
  catalogStateId:    number | null
  error:             string | null
}

export type PersistenceSummary = {
  total:     number
  succeeded: number
  failed:    number
  rows:      PersistenceRowResult[]
}

// ─── FLOW SUCCESS CHECK ───────────────────────────────────────

function isFlowFailed(result: InventoryFlowResult): boolean {
  return (
    result.inventoryItemStatus === "FAILED" ||
    result.offerStatus         === "FAILED" ||
    result.publishStatus       === "FAILED" ||
    result.inventoryItemStatus === "failed" ||
    result.offerStatus         === "failed" ||
    result.publishStatus       === "failed"
  )
}

function buildAmazonSourceUrl(asin: string): string {
  const normalized = String(asin || "").trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(normalized)) return ""
  return `https://www.amazon.com/dp/${normalized}`
}

function extractListingSnapshot(payload: EbayListingPayload) {
  const imageUrl = payload.images?.find((u) => String(u).trim().length > 0)?.trim() ?? null
  const sourcePrice = payload.amazonCost > 0 ? payload.amazonCost : null
  const sourceUrl = buildAmazonSourceUrl(payload.asin)
  return {
    title:       payload.title?.trim() || null,
    ebayPrice:   payload.price > 0 ? payload.price : null,
    quantity:    payload.quantity > 0 ? payload.quantity : null,
    imageUrl,
    sourceUrl:   sourceUrl || null,
    sourcePrice,
  }
}

// ─── ADIM 1: asin_pool güncelle ───────────────────────────────

async function updatePoolAfterPublish(poolId: number): Promise<boolean> {
  const result = await query(
    `UPDATE asin_pool
     SET status         = 'completed',
         listing_status = 'success',
         pipeline_stage = 'listed',
         updated_at     = NOW()
     WHERE id = $1
     RETURNING id`,
    [poolId]
  )
  return (result.rowCount ?? 0) > 0
}

// ─── ADIM 2: listing_history plain INSERT ─────────────────────

async function insertListingHistory(
  input: PersistenceInput,
  workspaceId: string
): Promise<number | null> {
  const { result, payload } = input
  const snap = extractListingSnapshot(payload)
  const ebayItemId = String(result.ebayListingId ?? "").trim()
  if (!ebayItemId) return null

  // Idempotent: same store + ebay item must not create duplicate history rows.
  const existing = await query<{ id: number }>(
    `SELECT id FROM listing_history
     WHERE store_id = $1 AND ebay_item_id = $2
     ORDER BY id DESC
     LIMIT 1`,
    [payload.assignedStoreId, ebayItemId]
  )
  if (existing.rows[0]?.id) {
    await query(
      `UPDATE listing_history
       SET workspace_id = $2,
           asin_registry_id = $3,
           internal_sku = COALESCE($4, internal_sku),
           ebay_offer_id = COALESCE($5, ebay_offer_id),
           amazon_url_snapshot = COALESCE($6, amazon_url_snapshot),
           title_snapshot = COALESCE($7, title_snapshot),
           price_snapshot = COALESCE($8, price_snapshot),
           status = 'live',
           updated_at = NOW()
       WHERE id = $1`,
      [
        existing.rows[0].id,
        workspaceId,
        payload.asinRegistryId,
        result.sku,
        result.ebayOfferId,
        snap.sourceUrl,
        snap.title,
        snap.ebayPrice,
      ]
    )
    return existing.rows[0].id
  }

  const res = await query<{ id: number }>(
    `INSERT INTO listing_history (
       workspace_id,
       store_id,
       asin_registry_id,
       internal_sku,
       ebay_item_id,
       ebay_offer_id,
       amazon_url_snapshot,
       title_snapshot,
       price_snapshot,
       status,
       listed_at,
       listing_job_ref,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'live', NOW(), $10, NOW(), NOW())
     RETURNING id`,
    [
      workspaceId,
      payload.assignedStoreId,
      payload.asinRegistryId,
      result.sku,
      ebayItemId,
      result.ebayOfferId,
      snap.sourceUrl,
      snap.title,
      snap.ebayPrice,
      payload.poolId,
    ]
  )

  return res.rows[0]?.id ?? null
}

// ─── ADIM 3: store_catalog_state upsert ───────────────────────

async function upsertStoreCatalogState(
  input: PersistenceInput,
  workspaceId: string
): Promise<number | null> {
  const { result, payload } = input
  const snap = extractListingSnapshot(payload)

  const res = await query<{ id: number }>(
    `INSERT INTO store_catalog_state (
       workspace_id,
       store_id,
       asin_registry_id,
       internal_sku,
       ebay_item_id,
       ebay_offer_id,
       ebay_title,
       ebay_price,
       ebay_quantity,
       image_url,
       source_url,
       source_price,
       ebay_price_synced_at,
       current_status,
       listed_at,
       last_seen_live_at,
       last_sync_at,
       source_of_truth,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), 'live', NOW(), NOW(), NOW(), $13, NOW(), NOW())
     ON CONFLICT (store_id, asin_registry_id)
     DO UPDATE SET
       workspace_id         = EXCLUDED.workspace_id,
       internal_sku         = EXCLUDED.internal_sku,
       ebay_item_id         = EXCLUDED.ebay_item_id,
       ebay_offer_id        = EXCLUDED.ebay_offer_id,
       ebay_title           = EXCLUDED.ebay_title,
       ebay_price           = EXCLUDED.ebay_price,
       ebay_quantity        = EXCLUDED.ebay_quantity,
       image_url            = COALESCE(EXCLUDED.image_url, store_catalog_state.image_url),
       source_url           = COALESCE(EXCLUDED.source_url, store_catalog_state.source_url),
       source_price         = COALESCE(EXCLUDED.source_price, store_catalog_state.source_price),
       ebay_price_synced_at = NOW(),
       current_status       = 'live',
       listed_at            = COALESCE(store_catalog_state.listed_at, EXCLUDED.listed_at),
       last_seen_live_at    = NOW(),
       last_sync_at         = NOW(),
       source_of_truth      = EXCLUDED.source_of_truth,
       updated_at           = NOW()
     RETURNING id`,
    [
      workspaceId,
      payload.assignedStoreId,
      payload.asinRegistryId,
      result.sku,
      result.ebayListingId,
      result.ebayOfferId,
      snap.title,
      snap.ebayPrice,
      snap.quantity,
      snap.imageUrl,
      snap.sourceUrl,
      snap.sourcePrice,
      "publish_snapshot",
    ]
  )

  return res.rows[0]?.id ?? null
}

// ─── ANA FONKSİYON ────────────────────────────────────────────

export async function persistPublishResults(
  inputs: PersistenceInput[]
): Promise<PersistenceSummary> {
  console.log(`[Persistence] Starting — ${inputs.length} item(s)`)

  const rows: PersistenceRowResult[] = []
  let succeeded = 0
  let failed    = 0

  for (const input of inputs) {
    const { result, payload } = input
    const { poolId, asin, sku } = result

    const row: PersistenceRowResult = {
      poolId,
      asin,
      sku,
      persisted:        false,
      poolUpdated:      false,
      listingHistoryId: null,
      catalogStateId:   null,
      error:            null
    }

    if (isFlowFailed(result)) {
      row.error = "Flow did not fully succeed — skipping persistence"
      rows.push(row)
      failed++
      console.log(`  [Persistence] Skipped: ASIN=${asin} | ${row.error}`)
      continue
    }

    if (!String(result.ebayListingId ?? "").trim()) {
      row.error = "Missing ebayListingId — skipping persistence"
      rows.push(row)
      failed++
      console.log(`  [Persistence] Skipped: ASIN=${asin} | ${row.error}`)
      continue
    }

    if (!String(result.ebayOfferId ?? "").trim()) {
      row.error = "PUBLISH_MISSING_OFFER_ID"
      console.warn(`  [Persistence] Publish succeeded without offerId ASIN=${asin} listingId=${result.ebayListingId}`)
    }

    if (!Number.isInteger(payload.assignedStoreId) || payload.assignedStoreId <= 0) {
      row.error = "Missing assignedStoreId — skipping persistence"
      rows.push(row)
      failed++
      console.log(`  [Persistence] Skipped: ASIN=${asin} | ${row.error}`)
      continue
    }

    try {
      const workspaceId = resolvePersistWorkspaceId(payload)
      console.log(
        `[Persistence] item ASIN=${asin} workspace=${workspaceId} store_id=${payload.assignedStoreId}`
      )
      row.poolUpdated      = await updatePoolAfterPublish(poolId)
      row.listingHistoryId = await insertListingHistory(input, workspaceId)
      row.catalogStateId   = await upsertStoreCatalogState(input, workspaceId)
      if (row.catalogStateId) {
        try {
          const { trySyncGlobalAsinConsumerFromCatalog } = await import("../globalKeepa/globalAsinConsumerSync")
          await trySyncGlobalAsinConsumerFromCatalog({
            workspaceId,
            storeId: payload.assignedStoreId,
            catalogStateId: row.catalogStateId,
          })
        } catch {
          /* consumer sync must not block persist */
        }
        try {
          const { emitKeepaAsinSyncForCatalog } = await import("../keepaSensor/keepaAsinSyncOutbox")
          await emitKeepaAsinSyncForCatalog({
            workspaceId,
            storeId: payload.assignedStoreId,
            catalogStateId: row.catalogStateId,
          })
        } catch {
          /* Keepa emit must not block persist */
        }
      }
      row.persisted = true
      if (row.error === "PUBLISH_MISSING_OFFER_ID") {
        failed++
      } else {
        succeeded++
      }

      const snap = extractListingSnapshot(payload)
      console.log("[ListingPersistence] saved local listing snapshot", {
        asin,
        sku,
        storeCode: payload.storeCode,
        ebayItemId: result.ebayListingId,
        ebayOfferId: result.ebayOfferId,
        ebayPrice: snap.ebayPrice,
        sourcePrice: snap.sourcePrice,
        hasImage: Boolean(snap.imageUrl),
        titlePreview: snap.title ? String(snap.title).slice(0, 80) : null,
      })
      console.log(
        `  [Persistence] OK: ASIN=${asin} | ` +
        `listing_history.id=${row.listingHistoryId} | ` +
        `catalog_state.id=${row.catalogStateId}`
      )
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err)
      failed++
      console.error(`  [Persistence] Failed: ASIN=${asin} | ${row.error}`)
    }

    rows.push(row)
  }

  console.log(
    `[Persistence] Done | total=${inputs.length} ` +
    `succeeded=${succeeded} failed=${failed}`
  )

  return { total: inputs.length, succeeded, failed, rows }
}

// ─── YARDIMCI: payload + result eşleştir ─────────────────────

export function zipPayloadsAndResults(
  payloads: EbayListingPayload[],
  results:  InventoryFlowResult[]
): PersistenceInput[] {
  const payloadMap = new Map<number, EbayListingPayload>()
  for (const p of payloads) {
    payloadMap.set(p.poolId, p)
  }

  const inputs: PersistenceInput[] = []
  for (const result of results) {
    const payload = payloadMap.get(result.poolId)
    if (payload) {
      inputs.push({ result, payload })
    } else {
      console.warn(`[Persistence] Payload not found for poolId=${result.poolId}`)
    }
  }
  return inputs
}
