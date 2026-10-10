import { queryWithoutJit } from "../../db/client"
import { LISTING_HAS_ASIN_SQL } from "./appListingFilters"
import { STOCK_ALERTS_VISIBLE_SQL } from "../stockAlerts/stockAlertListQuery"
import { getDashboardPeriodRange, type DashboardPeriod } from "./dashboardBusinessDay"

export type DashboardFinanceWindow = {
  orderCount: number
  ebayGrossSales: number
  ebayRemainingEarnings: number
  remainingOnKnownCost: number
  amazonCostKnownTotal: number
  profitOnKnownCost: number | null
  costKnownCount: number
  costTotalCount: number
  profitMarginPercent: number | null
}

export type DashboardOpsResponse = {
  ok: true
  scope: "store" | "all"
  storeId: number | null
  storeCode: string | null
  kpis: {
    activeListings: number
    ordersToday: number
    grossSalesToday: number
    netProfitToday: number | null
    needsAttention: number
    storesWithIssues: number | null
  }
  finance: {
    today: DashboardFinanceWindow
    week: DashboardFinanceWindow
    month: DashboardFinanceWindow
  }
  pipeline: {
    newOrders: number
    amazonOrdered: number
    shipped: number
    delayed: number
    delivered: number
    actionRequired: number
  }
  needsAttention: Array<{
    id: string
    title: string
    explanation: string
    count: number
    severity: "high" | "medium" | "low"
    href: string | null
  }>
  customerService: {
    sentToday: number
    failed: number
    thankYouToday: number
    shippedToday: number
    delayedToday: number
    deliveredToday: number
  }
  listingHealth: {
    activeListings: number
    outOfStock: number
    stockAlerts: number
    needsAsin: number
  }
  storeRows: Array<{
    storeId: number
    storeCode: string
    storeName: string
    ordersToday: number
    grossSalesToday: number
    knownSourceCostToday: number
    netProfitToday: number | null
    costKnownCount: number
    costTotalCount: number
    activeListings: number
    alerts: number
  }>
  recentActivity: Array<{
    id: string
    at: string
    title: string
    detail: string | null
    href: string | null
  }>
}

function emptyFinance(): DashboardFinanceWindow {
  return {
    orderCount: 0,
    ebayGrossSales: 0,
    ebayRemainingEarnings: 0,
    remainingOnKnownCost: 0,
    amazonCostKnownTotal: 0,
    profitOnKnownCost: null,
    costKnownCount: 0,
    costTotalCount: 0,
    profitMarginPercent: null,
  }
}

function n(v: string | null | undefined): number {
  const x = parseFloat(String(v ?? "0"))
  return Number.isFinite(x) ? x : 0
}

function ni(v: string | null | undefined): number {
  return parseInt(String(v ?? "0"), 10) || 0
}

function financeFromRow(r: {
  order_count: string
  gross: string
  earnings: string
  remaining_known: string
  amazon_cost: string
  profit_known: string | null
  cost_known: string
}): DashboardFinanceWindow {
  const remainingKnown = n(r.remaining_known)
  const profit =
    r.profit_known != null && r.profit_known !== "" ? n(r.profit_known) : null
  return {
    orderCount: ni(r.order_count),
    ebayGrossSales: n(r.gross),
    ebayRemainingEarnings: n(r.earnings),
    remainingOnKnownCost: remainingKnown,
    amazonCostKnownTotal: n(r.amazon_cost),
    profitOnKnownCost: profit,
    costKnownCount: ni(r.cost_known),
    costTotalCount: ni(r.order_count),
    profitMarginPercent:
      profit != null && remainingKnown > 0
        ? Math.round((profit / remainingKnown) * 1000) / 10
        : null,
  }
}

const STORE_SCOPE = `AND o.store_id IN (
  SELECT s.id FROM stores s
  WHERE s.workspace_id = $1::uuid AND s.status = 'active'
    AND ($2::int IS NULL OR s.id = $2)
)`

export async function getAppDashboardOps(
  workspaceId: string,
  store: { id: number; storeCode: string } | null,
  period: DashboardPeriod = "today"
): Promise<DashboardOpsResponse> {
  const storeId = store?.id ?? null
  const dashboardRange = getDashboardPeriodRange(period)
  const scopeParams: unknown[] = [workspaceId, storeId]
  const dashboardRangeParams: unknown[] = [workspaceId, storeId, dashboardRange.start, dashboardRange.end]

  const financeRes = await queryWithoutJit<{
    bucket: string
    order_count: string
    gross: string
    earnings: string
    remaining_known: string
    amazon_cost: string
    profit_known: string | null
    cost_known: string
  }>(
    `SELECT bucket,
            COUNT(*)::text AS order_count,
            COALESCE(SUM(total_amount), 0)::text AS gross,
            COALESCE(SUM(ebay_order_earnings), 0)::text AS earnings,
            COALESCE(SUM(ebay_order_earnings) FILTER (
              WHERE ebay_order_earnings IS NOT NULL AND amazon_purchase_price IS NOT NULL
            ), 0)::text AS remaining_known,
            COALESCE(SUM(amazon_purchase_price) FILTER (WHERE amazon_purchase_price IS NOT NULL), 0)::text AS amazon_cost,
            SUM(ebay_order_earnings - amazon_purchase_price) FILTER (
              WHERE ebay_order_earnings IS NOT NULL AND amazon_purchase_price IS NOT NULL
            )::text AS profit_known,
            COUNT(*) FILTER (WHERE amazon_purchase_price IS NOT NULL)::text AS cost_known
     FROM (
       SELECT $5::text AS bucket, o.total_amount, o.ebay_order_earnings, o.amazon_purchase_price
       FROM ebay_orders o
       WHERE o.workspace_id = $1::uuid ${STORE_SCOPE}
         AND o.order_created_at >= $3::timestamptz AND o.order_created_at <= $4::timestamptz
     ) x
     GROUP BY bucket`,
    [...dashboardRangeParams, period]
  )

  const today = emptyFinance()
  const week = emptyFinance()
  const month = emptyFinance()
  for (const r of financeRes.rows) {
    const w = financeFromRow(r)
    if (r.bucket === "today") Object.assign(today, w)
    else if (r.bucket === "week") Object.assign(week, w)
    else Object.assign(month, w)
  }

  const listingRes = await queryWithoutJit<{
    active: string
    out_of_stock: string
    alerts: string
    needs_asin: string
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM store_catalog_state scs
        WHERE scs.workspace_id = $1::uuid AND scs.panel_hidden_at IS NULL
          AND scs.current_status = 'live'
          AND ($2::int IS NULL OR scs.store_id = $2)) AS active,
       (SELECT COUNT(*)::text FROM store_catalog_state scs
        WHERE scs.workspace_id = $1::uuid AND scs.panel_hidden_at IS NULL
          AND scs.current_status = 'live'
          AND COALESCE(scs.ebay_quantity, 0) <= 0
          AND ($2::int IS NULL OR scs.store_id = $2)) AS out_of_stock,
       (SELECT COUNT(*)::text FROM stock_review_items sri
        WHERE sri.workspace_id = $1::uuid
          AND sri.review_status = 'pending'
          AND ${STOCK_ALERTS_VISIBLE_SQL}
          AND ($2::int IS NULL OR sri.store_id = $2)) AS alerts,
       (SELECT COUNT(*)::text FROM store_catalog_state scs
        LEFT JOIN asin_registry ar ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
        WHERE scs.workspace_id = $1::uuid AND scs.panel_hidden_at IS NULL
          AND ($2::int IS NULL OR scs.store_id = $2)
          AND NOT (${LISTING_HAS_ASIN_SQL})) AS needs_asin`,
    scopeParams
  )
  const listing = listingRes.rows[0]
  const listingHealth = {
    activeListings: ni(listing?.active),
    outOfStock: ni(listing?.out_of_stock),
    stockAlerts: ni(listing?.alerts),
    needsAsin: ni(listing?.needs_asin),
  }

  const pipeRes = await queryWithoutJit<{
    new_orders: string
    amazon_ordered: string
    shipped: string
    delayed: string
    delivered: string
    action_required: string
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE COALESCE(o.operation_status, 'AMAZON_PENDING') IN ('NEW_ORDER', 'AMAZON_PENDING')
       )::text AS new_orders,
       COUNT(*) FILTER (
         WHERE o.operation_status = 'AMAZON_ORDERED'
           AND COALESCE(o.amazon_delivery_status, '') NOT IN ('SHIPPED', 'DELAYED', 'DELIVERED')
       )::text AS amazon_ordered,
       COUNT(*) FILTER (
         WHERE UPPER(COALESCE(o.amazon_delivery_status, '')) = 'SHIPPED'
            OR o.operation_status IN ('TRACKING_PENDING', 'TRACKING_RECEIVED', 'EBAY_TRACKING_SUBMITTED', 'IN_TRANSIT')
       )::text AS shipped,
       COUNT(*) FILTER (WHERE UPPER(COALESCE(o.amazon_delivery_status, '')) = 'DELAYED')::text AS delayed,
       COUNT(*) FILTER (
         WHERE o.operation_status = 'DELIVERED'
            OR UPPER(COALESCE(o.amazon_delivery_status, '')) = 'DELIVERED'
       )::text AS delivered,
       COUNT(*) FILTER (
         WHERE o.operation_status IN ('PROBLEM', 'CANCELLED_REFUNDED')
       )::text AS action_required
     FROM ebay_orders o
     WHERE o.workspace_id = $1::uuid ${STORE_SCOPE}
       AND o.order_created_at >= $3::timestamptz AND o.order_created_at <= $4::timestamptz`,
    dashboardRangeParams
  )
  const pipe = pipeRes.rows[0]
  const pipeline = {
    newOrders: ni(pipe?.new_orders),
    amazonOrdered: ni(pipe?.amazon_ordered),
    shipped: ni(pipe?.shipped),
    delayed: ni(pipe?.delayed),
    delivered: ni(pipe?.delivered),
    actionRequired: ni(pipe?.action_required),
  }

  const attnRes = await queryWithoutJit<{
    delayed: string
    missing_cost: string
    unmatched_mail: string
    cs_failed: string
    returns: string
    cancels: string
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM ebay_orders o
        WHERE o.workspace_id = $1::uuid ${STORE_SCOPE}
          AND UPPER(COALESCE(o.amazon_delivery_status, '')) = 'DELAYED'
          AND o.order_created_at >= $3::timestamptz AND o.order_created_at <= $4::timestamptz) AS delayed,
       (SELECT COUNT(*)::text FROM ebay_orders o
        WHERE o.workspace_id = $1::uuid ${STORE_SCOPE}
          AND o.order_created_at >= $3::timestamptz AND o.order_created_at <= $4::timestamptz
          AND o.amazon_purchase_price IS NULL) AS missing_cost,
       (SELECT COUNT(*)::text FROM mailbox_link_reviews r
        WHERE r.workspace_id = $1::uuid AND r.status = 'OPEN'
          AND ($2::int IS NULL OR r.store_id = $2)) AS unmatched_mail,
       (SELECT COUNT(*)::text FROM customer_service_sends cs
        WHERE cs.workspace_id = $1::uuid AND cs.status = 'failed'
          AND ($2::int IS NULL OR cs.store_id = $2)) AS cs_failed,
       (SELECT COUNT(*)::text FROM mailbox_messages m
        WHERE m.workspace_id = $1::uuid AND m.classified_type = 'EBAY_RETURN_REQUEST'
          AND m.received_at >= $3::timestamptz AND m.received_at <= $4::timestamptz
          AND ($2::int IS NULL OR m.store_id = $2)) AS returns,
       (SELECT COUNT(*)::text FROM mailbox_messages m
        WHERE m.workspace_id = $1::uuid AND m.classified_type IN ('EBAY_CANCEL_REQUEST', 'EBAY_CANCELLED')
          AND m.received_at >= $3::timestamptz AND m.received_at <= $4::timestamptz
          AND ($2::int IS NULL OR m.store_id = $2)) AS cancels`,
    dashboardRangeParams
  )
  const attn = attnRes.rows[0]
  const needsAttention: DashboardOpsResponse["needsAttention"] = []
  const pushAttn = (
    id: string,
    title: string,
    explanation: string,
    count: number,
    severity: "high" | "medium" | "low",
    href: string | null
  ) => {
    if (count <= 0) return
    needsAttention.push({ id, title, explanation, count, severity, href })
  }
  pushAttn(
    "delayed",
    "Delayed shipments",
    "Source delivery status is delayed.",
    ni(attn?.delayed),
    "high",
    "/app/orders"
  )
  pushAttn(
    "missing_cost",
    "Missing Amazon cost",
    "Orders in the selected period without a verified source cost. Cost is not treated as $0.",
    ni(attn?.missing_cost),
    "medium",
    "/app/orders"
  )
  pushAttn(
    "unmatched",
    "Unmatched Amazon emails",
    "Mailbox reviews still open.",
    ni(attn?.unmatched_mail),
    "medium",
    null
  )
  pushAttn(
    "cs_failed",
    "Failed customer messages",
    "Automation sends that did not complete.",
    ni(attn?.cs_failed),
    "high",
    "/app/customer-service"
  )
  pushAttn(
    "returns",
    "Return-related mail",
    "eBay return mail in the selected period.",
    ni(attn?.returns),
    "medium",
    null
  )
  pushAttn(
    "cancels",
    "Cancellation-related mail",
    "eBay cancel mail in the selected period.",
    ni(attn?.cancels),
    "medium",
    null
  )
  pushAttn(
    "stock",
    "Stock alerts",
    "Pending stock review items.",
    listingHealth.stockAlerts,
    listingHealth.stockAlerts > 10 ? "high" : "medium",
    "/app/stock-alerts"
  )
  pushAttn(
    "asin",
    "Listings missing ASIN",
    "Imported listings without a linked Amazon source.",
    listingHealth.needsAsin,
    "low",
    "/app/import?mode=asin-match"
  )

  const csRes = await queryWithoutJit<{
    sent_today: string
    failed: string
    thank_you: string
    shipped: string
    delayed: string
    delivered: string
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'sent' AND sent_at >= $3::timestamptz AND sent_at <= $4::timestamptz)::text AS sent_today,
       COUNT(*) FILTER (
         WHERE status = 'failed'
           AND COALESCE(sent_at, created_at) >= $3::timestamptz
           AND COALESCE(sent_at, created_at) <= $4::timestamptz
       )::text AS failed,
       COUNT(*) FILTER (WHERE automation_type = 'THANK_YOU' AND status = 'sent' AND sent_at >= $3::timestamptz AND sent_at <= $4::timestamptz)::text AS thank_you,
       COUNT(*) FILTER (WHERE automation_type = 'SHIPPED' AND status = 'sent' AND sent_at >= $3::timestamptz AND sent_at <= $4::timestamptz)::text AS shipped,
       COUNT(*) FILTER (WHERE automation_type = 'DELAYED' AND status = 'sent' AND sent_at >= $3::timestamptz AND sent_at <= $4::timestamptz)::text AS delayed,
       COUNT(*) FILTER (WHERE automation_type = 'DELIVERED' AND status = 'sent' AND sent_at >= $3::timestamptz AND sent_at <= $4::timestamptz)::text AS delivered
     FROM customer_service_sends
     WHERE workspace_id = $1::uuid
       AND ($2::int IS NULL OR store_id = $2)`,
    dashboardRangeParams
  )
  const cs = csRes.rows[0]
  const customerService = {
    sentToday: ni(cs?.sent_today),
    failed: ni(cs?.failed),
    thankYouToday: ni(cs?.thank_you),
    shippedToday: ni(cs?.shipped),
    delayedToday: ni(cs?.delayed),
    deliveredToday: ni(cs?.delivered),
  }

  const storeRowsRes = await queryWithoutJit<{
    store_id: number
    store_code: string
    store_name: string
    orders_today: string
    gross_today: string
    cost_today: string
    profit_today: string | null
    cost_known: string
    cost_total: string
    active_listings: string
    alerts: string
  }>(
    `SELECT
       s.id AS store_id,
       s.store_code,
       s.name AS store_name,
       COALESCE(f.orders_today, '0') AS orders_today,
       COALESCE(f.gross_today, '0') AS gross_today,
       COALESCE(f.cost_today, '0') AS cost_today,
       f.profit_today,
       COALESCE(f.cost_known, '0') AS cost_known,
       COALESCE(f.cost_total, '0') AS cost_total,
       (SELECT COUNT(*)::text FROM store_catalog_state scs
        WHERE scs.workspace_id = s.workspace_id AND scs.store_id = s.id
          AND scs.panel_hidden_at IS NULL AND scs.current_status = 'live') AS active_listings,
       (SELECT COUNT(*)::text FROM stock_review_items sri
        WHERE sri.workspace_id = s.workspace_id AND sri.store_id = s.id
          AND sri.review_status = 'pending' AND ${STOCK_ALERTS_VISIBLE_SQL}) AS alerts
     FROM stores s
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::text AS orders_today,
              COALESCE(SUM(total_amount), 0)::text AS gross_today,
              COALESCE(SUM(amazon_purchase_price) FILTER (WHERE amazon_purchase_price IS NOT NULL), 0)::text AS cost_today,
              SUM(ebay_order_earnings - amazon_purchase_price) FILTER (
                WHERE ebay_order_earnings IS NOT NULL AND amazon_purchase_price IS NOT NULL
              )::text AS profit_today,
              COUNT(*) FILTER (WHERE amazon_purchase_price IS NOT NULL)::text AS cost_known,
              COUNT(*)::text AS cost_total
       FROM ebay_orders o
       WHERE o.workspace_id = s.workspace_id AND o.store_id = s.id
         AND o.order_created_at >= $2::timestamptz AND o.order_created_at <= $3::timestamptz
     ) f ON true
     WHERE s.workspace_id = $1::uuid AND s.status = 'active'
     ORDER BY s.store_code ASC`,
    [workspaceId, dashboardRange.start, dashboardRange.end]
  )
  const storeRows = storeRowsRes.rows.map(r => ({
    storeId: Number(r.store_id),
    storeCode: r.store_code,
    storeName: r.store_name,
    ordersToday: ni(r.orders_today),
    grossSalesToday: n(r.gross_today),
    knownSourceCostToday: n(r.cost_today),
    netProfitToday:
      r.profit_today != null && r.profit_today !== "" ? n(r.profit_today) : null,
    costKnownCount: ni(r.cost_known),
    costTotalCount: ni(r.cost_total),
    activeListings: ni(r.active_listings),
    alerts: ni(r.alerts),
  }))

  const eventsRes = await queryWithoutJit<{
    id: number
    event_type: string
    message: string | null
    created_at: string
    ebay_order_id: string
    order_pk: number
    store_code: string
  }>(
    `SELECT e.id, e.event_type, e.message, e.created_at::text AS created_at,
            o.ebay_order_id, o.id AS order_pk, s.store_code
     FROM ebay_order_events e
     JOIN ebay_orders o ON o.id = e.order_id
     JOIN stores s ON s.id = o.store_id
     WHERE e.workspace_id = $1::uuid ${STORE_SCOPE}
       AND e.created_at >= $3::timestamptz AND e.created_at <= $4::timestamptz
     ORDER BY e.created_at DESC
     LIMIT 12`,
    dashboardRangeParams
  )
  const csEventsRes = await queryWithoutJit<{
    id: number
    automation_type: string
    status: string
    ebay_order_id: string
    created_at: string
  }>(
    `SELECT id, automation_type, status, ebay_order_id, COALESCE(sent_at, created_at)::text AS created_at
     FROM customer_service_sends
     WHERE workspace_id = $1::uuid
       AND ($2::int IS NULL OR store_id = $2)
       AND status = 'sent'
       AND COALESCE(sent_at, created_at) >= $3::timestamptz AND COALESCE(sent_at, created_at) <= $4::timestamptz
     ORDER BY COALESCE(sent_at, created_at) DESC
     LIMIT 6`,
    dashboardRangeParams
  )

  const recentActivity: DashboardOpsResponse["recentActivity"] = [
    ...eventsRes.rows.map(r => ({
      id: `evt-${r.id}`,
      at: r.created_at,
      title: r.event_type.replace(/_/g, " "),
      detail: r.message || `${r.store_code} · ${r.ebay_order_id}`,
      href: `/app/orders/${r.order_pk}`,
    })),
    ...csEventsRes.rows.map(r => ({
      id: `cs-${r.id}`,
      at: r.created_at,
      title: `CS ${r.automation_type} ${r.status}`,
      detail: r.ebay_order_id,
      href: "/app/customer-service",
    })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 14)

  const storesWithIssues = storeRows.filter(
    r => r.alerts > 0 || (r.costTotalCount > 0 && r.costKnownCount < r.costTotalCount)
  ).length

  const needsAttentionCount = needsAttention.reduce((sum, row) => sum + row.count, 0)

  return {
    ok: true,
    scope: store ? "store" : "all",
    storeId: store?.id ?? null,
    storeCode: store?.storeCode ?? null,
    kpis: {
      activeListings: listingHealth.activeListings,
      ordersToday: (period === "today" ? today : period === "week" ? week : month).orderCount,
      grossSalesToday: (period === "today" ? today : period === "week" ? week : month).ebayGrossSales,
      netProfitToday: (period === "today" ? today : period === "week" ? week : month).profitOnKnownCost,
      needsAttention: needsAttentionCount,
      storesWithIssues: store ? null : storesWithIssues,
    },
    finance: { today, week, month },
    pipeline,
    needsAttention,
    customerService,
    listingHealth,
    storeRows: store ? [] : storeRows,
    recentActivity,
  }
}
