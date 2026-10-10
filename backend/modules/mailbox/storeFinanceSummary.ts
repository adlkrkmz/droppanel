import { query } from "../../db/client"
import { orderProfitFromRemainingAndCost } from "./mailboxTypes"

export type StoreFinanceWindow = {
  orderCount: number
  ebayGrossSales: number
  ebayRemainingEarnings: number
  amazonCostKnownTotal: number
  profitOnKnownCost: number | null
  costKnownCount: number
  costTotalCount: number
}

export type StoreFinanceSummary = {
  storeCode: string
  storeId: number
  today: StoreFinanceWindow
  week: StoreFinanceWindow
}

function emptyWindow(): StoreFinanceWindow {
  return {
    orderCount: 0,
    ebayGrossSales: 0,
    ebayRemainingEarnings: 0,
    amazonCostKnownTotal: 0,
    profitOnKnownCost: null,
    costKnownCount: 0,
    costTotalCount: 0,
  }
}

function n(v: string | null | undefined): number {
  const x = parseFloat(String(v ?? "0"))
  return Number.isFinite(x) ? x : 0
}

function ni(v: string | null | undefined): number {
  return parseInt(String(v ?? "0"), 10) || 0
}

export async function getStoreFinanceSummary(
  workspaceId: string,
  storeId: number,
  storeCode: string
): Promise<StoreFinanceSummary> {
  const res = await query<{
    bucket: string
    order_count: string
    gross: string
    earnings: string
    amazon_cost: string
    profit_known: string | null
    cost_known: string
  }>(
    `SELECT bucket,
            COUNT(*)::text AS order_count,
            COALESCE(SUM(total_amount), 0)::text AS gross,
            COALESCE(SUM(ebay_order_earnings), 0)::text AS earnings,
            COALESCE(SUM(amazon_purchase_price) FILTER (WHERE amazon_purchase_price IS NOT NULL), 0)::text AS amazon_cost,
            SUM(ebay_order_earnings - amazon_purchase_price) FILTER (
              WHERE ebay_order_earnings IS NOT NULL AND amazon_purchase_price IS NOT NULL
            )::text AS profit_known,
            COUNT(*) FILTER (WHERE amazon_purchase_price IS NOT NULL)::text AS cost_known
     FROM (
       SELECT 'today' AS bucket, total_amount, ebay_order_earnings, amazon_purchase_price
       FROM ebay_orders
       WHERE workspace_id = $1::uuid AND store_id = $2
         AND order_created_at >= date_trunc('day', NOW())
       UNION ALL
       SELECT 'week' AS bucket, total_amount, ebay_order_earnings, amazon_purchase_price
       FROM ebay_orders
       WHERE workspace_id = $1::uuid AND store_id = $2
         AND order_created_at >= date_trunc('week', NOW())
     ) x
     GROUP BY bucket`,
    [workspaceId, storeId]
  )

  const today = emptyWindow()
  const week = emptyWindow()
  for (const r of res.rows) {
    const w = r.bucket === "today" ? today : week
    w.orderCount = ni(r.order_count)
    w.ebayGrossSales = n(r.gross)
    w.ebayRemainingEarnings = n(r.earnings)
    w.amazonCostKnownTotal = n(r.amazon_cost)
    w.costKnownCount = ni(r.cost_known)
    w.costTotalCount = w.orderCount
    const pk = r.profit_known != null && r.profit_known !== "" ? n(r.profit_known) : null
    w.profitOnKnownCost = pk
  }
  return { storeCode, storeId, today, week }
}

export function orderDetailProfit(earnings: number | null, amazonCost: number | null) {
  return orderProfitFromRemainingAndCost({
    ebayRemainingEarnings: earnings,
    amazonFinalCost: amazonCost,
  })
}
