import { query } from "../../db/client"
import { EbayApiClient } from "../ebay/ebayApiClient"
import { getValidAccessToken } from "../ebayOAuth/ebayOAuthService"

export async function enrichEbayTrackingIfMissing(input: {
  workspaceId: string
  orderPk: number
}): Promise<void> {
  const cur = await query<{
    ebay_order_id: string
    store_code: string
    ebay_tracking_number: string | null
    ebay_tracking_checked_at: Date | null
  }>(
    `SELECT o.ebay_order_id, o.store_code, o.ebay_tracking_number, o.ebay_tracking_checked_at
     FROM ebay_orders o
     WHERE o.workspace_id = $1::uuid AND o.id = $2`,
    [input.workspaceId, input.orderPk]
  )
  const row = cur.rows[0]
  if (!row) return
  if (row.ebay_tracking_number) return
  if (row.ebay_tracking_checked_at && Date.now() - new Date(row.ebay_tracking_checked_at).getTime() < 30 * 60 * 1000) {
    return
  }
  try {
    const token = await getValidAccessToken(input.workspaceId, row.store_code, false)
    const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
    const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })
    const ship = await client.getShippingFulfillments(row.ebay_order_id)
    await query(
      `UPDATE ebay_orders
       SET ebay_tracking_number = COALESCE($3, ebay_tracking_number),
           ebay_tracking_carrier = COALESCE($4, ebay_tracking_carrier),
           ebay_shipment_status = COALESCE($5, ebay_shipment_status),
           ebay_shipped_at = COALESCE($6::timestamptz, ebay_shipped_at),
           ebay_tracking_checked_at = NOW(),
           updated_at = NOW()
       WHERE workspace_id = $1::uuid AND id = $2`,
      [
        input.workspaceId,
        input.orderPk,
        ship?.trackingNumber ?? null,
        ship?.carrier ?? null,
        ship?.shipmentStatus ?? null,
        ship?.shippedAt ?? null,
      ]
    )
  } catch {
    await query(
      `UPDATE ebay_orders SET ebay_tracking_checked_at = NOW() WHERE workspace_id = $1::uuid AND id = $2`,
      [input.workspaceId, input.orderPk]
    )
  }
}
