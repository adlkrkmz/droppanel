import { query } from "../../db/client"
import { afterListingMonitoringStopped } from "../stockGuard/stockGuardV2LifecycleHooks"
import { EbayApiClient } from "../ebay/ebayApiClient"
import { getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import type {
  EndListingItemResult,
  EndListingRequest,
  EndListingResponse,
} from "./listingsEndTypes"

type StoreRow = { id: number; name: string }

type CatalogRow = {
  ebay_item_id:  string
  ebay_offer_id: string | null
}

function normalizeEndItems(items: EndListingRequest["items"]): {
  ebayIds:        string[]
  catalogOnlyIds: number[]
} {
  const ebayIds: string[] = []
  const catalogOnlyIds: number[] = []
  const seenEbay = new Set<string>()
  const seenCatalog = new Set<number>()

  for (const item of items) {
    const ebayId = String(item.ebayItemId ?? "").trim()
    const catalogId =
      item.catalogStateId != null && item.catalogStateId > 0 ? item.catalogStateId : null

    if (ebayId) {
      if (!seenEbay.has(ebayId)) {
        seenEbay.add(ebayId)
        ebayIds.push(ebayId)
      }
      continue
    }

    if (catalogId != null && !seenCatalog.has(catalogId)) {
      seenCatalog.add(catalogId)
      catalogOnlyIds.push(catalogId)
    }
  }

  return { ebayIds, catalogOnlyIds }
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

async function loadCatalogRows(
  workspaceId: string,
  storeId:     number,
  ebayIds:     string[]
): Promise<Map<string, CatalogRow>> {
  if (ebayIds.length === 0) return new Map()

  const result = await query<CatalogRow>(
    `SELECT trim(ebay_item_id) AS ebay_item_id, ebay_offer_id
     FROM store_catalog_state
     WHERE workspace_id = $1
       AND store_id = $2
       AND trim(ebay_item_id) = ANY($3::text[])`,
    [workspaceId, storeId, ebayIds]
  )

  return new Map(result.rows.map(r => [r.ebay_item_id, r]))
}

async function markListingEnded(
  workspaceId: string,
  storeId:     number,
  ebayItemId:  string
): Promise<boolean> {
  const result = await query(
    `UPDATE store_catalog_state
     SET current_status = 'ended',
         ebay_quantity = 0,
         last_seen_ended_at = NOW(),
         panel_hidden_at = NOW(),
         updated_at = NOW()
     WHERE workspace_id = $1
       AND store_id = $2
       AND trim(ebay_item_id) = $3`,
    [workspaceId, storeId, ebayItemId]
  )
  return (result.rowCount ?? 0) > 0
}

async function markListingEndedByCatalogId(
  workspaceId:    string,
  storeId:        number,
  catalogStateId: number
): Promise<boolean> {
  const result = await query(
    `UPDATE store_catalog_state
     SET current_status = 'ended',
         ebay_quantity = 0,
         last_seen_ended_at = NOW(),
         panel_hidden_at = NOW(),
         updated_at = NOW()
     WHERE workspace_id = $1
       AND store_id = $2
       AND id = $3`,
    [workspaceId, storeId, catalogStateId]
  )
  return (result.rowCount ?? 0) > 0
}

export async function endListings(
  workspaceId: string,
  req:         EndListingRequest
): Promise<EndListingResponse> {
  const storeCode = req.storeCode?.trim()
  if (!storeCode) throw new Error("storeCode is required")

  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error("Active store not found")

  const { ebayIds, catalogOnlyIds } = normalizeEndItems(req.items)
  if (ebayIds.length === 0 && catalogOnlyIds.length === 0) {
    throw new Error("items must include ebayItemId and/or catalogStateId")
  }
  const simulation = (process.env.EBAY_SIMULATION ?? "true") !== "false"
  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"

  const rowMap = await loadCatalogRows(workspaceId, store.id, ebayIds)

  let client: EbayApiClient | null = null
  if (!simulation && ebayIds.length > 0) {
    const token = await getValidAccessToken(workspaceId, storeCode, false)
    client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })
  }

  const results: EndListingItemResult[] = []
  let ended = 0
  let notFound = 0
  let failed = 0

  for (const ebayItemId of ebayIds) {
    const row = rowMap.get(ebayItemId)
    if (!row) {
      results.push({
        ebayItemId,
        status:  "NOT_FOUND",
        message: "Listing not found in store",
      })
      notFound++
      continue
    }

    if (simulation) {
      results.push({
        ebayItemId,
        status:  "SIMULATION",
        message: "Simulation mode — no eBay or DB changes",
      })
      continue
    }

    const offerId = row.ebay_offer_id?.trim()

    try {
      if (offerId) {
        await client!.withdrawOffer(offerId)
        await markListingEnded(workspaceId, store.id, ebayItemId)
        await afterListingMonitoringStopped({
          workspaceId,
          ebayItemIds: [ebayItemId],
        })
        results.push({
          ebayItemId,
          status:  "ENDED_BY_OFFER",
          message: "Listing ended on eBay via offer withdraw.",
        })
      } else {
        await client!.endFixedPriceItem(ebayItemId)
        await markListingEnded(workspaceId, store.id, ebayItemId)
        await afterListingMonitoringStopped({
          workspaceId,
          ebayItemIds: [ebayItemId],
        })
        results.push({
          ebayItemId,
          status:  "ENDED_BY_ITEM_ID",
          message: "Listing ended on eBay via Trading API.",
        })
      }
      ended++
    } catch (e) {
      results.push({
        ebayItemId,
        status:  "FAILED",
        message: e instanceof Error ? e.message : "Failed to end listing on eBay",
      })
      failed++
    }
  }

  for (const catalogStateId of catalogOnlyIds) {
    if (simulation) {
      results.push({
        catalogStateId,
        status:  "SIMULATION",
        message: "Simulation mode — no eBay or DB changes",
      })
      continue
    }

    const updated = await markListingEndedByCatalogId(workspaceId, store.id, catalogStateId)
    if (updated) {
      await afterListingMonitoringStopped({
        workspaceId,
        catalogStateIds: [catalogStateId],
      })
      results.push({
        catalogStateId,
        status:  "ENDED_LOCALLY",
        message: "Listing marked ended in panel only (no eBay item ID).",
      })
      ended++
    } else {
      results.push({
        catalogStateId,
        status:  "NOT_FOUND",
        message: "Listing not found in store",
      })
      notFound++
    }
  }

  return { ok: true, ended, notFound, failed, results }
}
