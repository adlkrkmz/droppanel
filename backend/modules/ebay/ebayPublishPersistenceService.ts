// ─────────────────────────────────────────────────────────────
// ebayPublishPersistenceService.ts
//
// Başarılı eBay publish sonuçlarını DB'ye yazar:
//   1. asin_pool           → status / listing_status / pipeline_stage
//   2. listing_history     → plain INSERT (no conflict constraint)
//   3. store_catalog_state → upsert ON CONFLICT (store_id, asin_registry_id)
//
// workspace_id : process.env.WORKSPACE_ID  (zorunlu)
// store_id     : payload.assignedStoreId
// ─────────────────────────────────────────────────────────────

import { query } from "../../db/client"
import type { InventoryFlowResult } from "./ebayApiTypes"
import type { EbayListingPayload } from "./ebayPayloadService"

// ─── WORKSPACE GUARD ──────────────────────────────────────────

function getWorkspaceId(): string {
  const id = process.env.WORKSPACE_ID
  if (!id) throw new Error("WORKSPACE_ID is not defined in environment")
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

  const res = await query<{ id: number }>(
    `INSERT INTO listing_history (
       workspace_id,
       store_id,
       asin_registry_id,
       internal_sku,
       ebay_item_id,
       ebay_offer_id,
       status,
       listed_at,
       listing_job_ref,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'live', NOW(), $7, NOW(), NOW())
     RETURNING id`,
    [
      workspaceId,              // workspace_id = process.env.WORKSPACE_ID
      payload.assignedStoreId,  // store_id
      payload.asinRegistryId,   // asin_registry_id
      result.sku,               // internal_sku
      result.ebayListingId,     // ebay_item_id
      result.ebayOfferId,       // ebay_offer_id
      payload.poolId            // listing_job_ref
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

  const res = await query<{ id: number }>(
    `INSERT INTO store_catalog_state (
       workspace_id,
       store_id,
       asin_registry_id,
       internal_sku,
       ebay_item_id,
       ebay_offer_id,
       current_status,
       listed_at,
       last_seen_live_at,
       last_sync_at,
       source_of_truth,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'live', NOW(), NOW(), NOW(), $7, NOW(), NOW())
     ON CONFLICT (store_id, asin_registry_id)
     DO UPDATE SET
       internal_sku      = EXCLUDED.internal_sku,
       ebay_item_id      = EXCLUDED.ebay_item_id,
       ebay_offer_id     = EXCLUDED.ebay_offer_id,
       current_status    = 'live',
       listed_at         = NOW(),
       last_seen_live_at = NOW(),
       last_sync_at      = NOW(),
       source_of_truth   = EXCLUDED.source_of_truth,
       updated_at        = NOW()
     RETURNING id`,
    [
      workspaceId,              // workspace_id = process.env.WORKSPACE_ID
      payload.assignedStoreId,  // store_id
      payload.asinRegistryId,   // asin_registry_id
      result.sku,               // internal_sku
      result.ebayListingId,     // ebay_item_id
      result.ebayOfferId,       // ebay_offer_id
      "ebay_simulation"         // source_of_truth
    ]
  )

  return res.rows[0]?.id ?? null
}

// ─── ANA FONKSİYON ────────────────────────────────────────────

export async function persistPublishResults(
  inputs: PersistenceInput[]
): Promise<PersistenceSummary> {
  const workspaceId = getWorkspaceId()

  console.log(`[Persistence] Starting — ${inputs.length} item | workspace=${workspaceId}`)

  const rows: PersistenceRowResult[] = []
  let succeeded = 0
  let failed    = 0

  for (const input of inputs) {
    const { result } = input
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

    try {
      row.poolUpdated      = await updatePoolAfterPublish(poolId)
      row.listingHistoryId = await insertListingHistory(input, workspaceId)
      row.catalogStateId   = await upsertStoreCatalogState(input, workspaceId)
      row.persisted        = true
      succeeded++
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
