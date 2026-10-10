import { query } from "../../db/client"
import { readListingQuantityOnEbay } from "../stockAlerts/stockAlertsEbayZeroService"
import { getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import { EbayApiClient } from "../ebay/ebayApiClient"
import { readListingEbayPriceFromClient } from "../listings/listingsEbayPriceService"

const sandbox = () => (process.env.EBAY_SANDBOX ?? "true") !== "false"

async function loadListing(workspaceId: string, catalogStateId: number) {
  const res = await query<{
    store_code: string
    store_id: string
    internal_sku: string | null
    ebay_item_id: string | null
    ebay_offer_id: string | null
  }>(
    `SELECT st.store_code, scs.store_id::text, scs.internal_sku, scs.ebay_item_id, scs.ebay_offer_id
     FROM store_catalog_state scs
     JOIN stores st ON st.id = scs.store_id AND st.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid AND scs.id = $2::bigint
     LIMIT 1`,
    [workspaceId, catalogStateId]
  )
  return res.rows[0] ?? null
}

export async function readOxylabsApplyQuantity(workspaceId: string, catalogStateId: number): Promise<number | null> {
  const cat = await loadListing(workspaceId, catalogStateId)
  if (!cat) return null
  return readListingQuantityOnEbay(
    workspaceId,
    cat.store_code,
    {
      internalSku: cat.internal_sku,
      ebayItemId: cat.ebay_item_id,
      ebayOfferId: cat.ebay_offer_id,
    },
    sandbox(),
    Number(cat.store_id)
  )
}

export async function readOxylabsApplyPrice(workspaceId: string, catalogStateId: number): Promise<number | null> {
  const cat = await loadListing(workspaceId, catalogStateId)
  if (!cat) return null
  try {
    const token = await getValidAccessToken(workspaceId, cat.store_code, false)
    const client = new EbayApiClient({ oauthToken: token, sandbox: sandbox(), simulationMode: false })
    return await readListingEbayPriceFromClient(client, {
      sku: cat.internal_sku?.trim() ?? "",
      itemId: cat.ebay_item_id?.trim() ?? "",
      offerIdFromDb: cat.ebay_offer_id?.trim() ?? "",
    })
  } catch {
    return null
  }
}
