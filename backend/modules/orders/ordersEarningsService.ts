// ----------------------------------------------------------------
// ordersEarningsService.ts — per-order eBay Order earnings fetch + persist
// ----------------------------------------------------------------

import { EbayApiClient } from "../ebay/ebayApiClient"
import { getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import { query } from "../../db/client"
import { getOrderDetail } from "./ordersRepository"
import type { OrderDetail, OrderFinanceSummary } from "./ordersTypes"

const LOG = "[OrderEarningsSync]"

/** Skip re-fetch after hard API error until next tick window. */
const ERROR_RETRY_COOLDOWN_MS = 10 * 60 * 1000

type OrderEarningsDbRow = {
  id:                             number
  store_code:                     string
  ebay_order_id:                  string
  legacy_order_id:                string | null
  order_updated_at:               string | null
  ebay_order_earnings:            string | null
  ebay_order_earnings_currency:   string | null
  ebay_order_earnings_source:     string | null
  ebay_order_earnings_checked_at: string | null
  ebay_order_earnings_error:      string | null
}

export type EarningsSyncStats = {
  earningsChecked:         number
  earningsSaved:           number
  earningsAlreadyPresent:  number
  earningsPending:         number
  earningsFailed:          number
  earningsSkippedCooldown:   number
  earningsRefreshedStale:  number
}

function emptyStats(): EarningsSyncStats {
  return {
    earningsChecked:        0,
    earningsSaved:          0,
    earningsAlreadyPresent: 0,
    earningsPending:        0,
    earningsFailed:         0,
    earningsSkippedCooldown:  0,
    earningsRefreshedStale: 0,
  }
}

function parseMoney(raw: string | null): number | null {
  if (raw == null || raw === "") return null
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

function parseTs(raw: string | null | undefined): number | null {
  if (!raw?.trim()) return null
  const t = new Date(raw).getTime()
  return Number.isNaN(t) ? null : t
}

function isEbaySandbox(): boolean {
  // Match ordersSyncService / soldItemAutoRestockService.
  return (process.env.EBAY_SANDBOX ?? "true") !== "false"
}

export function mapFinanceSummary(row: {
  ebay_order_earnings: string | null
  ebay_order_earnings_currency: string | null
  ebay_order_earnings_source: string | null
  ebay_order_earnings_checked_at: string | null
  ebay_order_earnings_error: string | null
}): OrderFinanceSummary {
  const amount = parseMoney(row.ebay_order_earnings)
  const checkedAt = row.ebay_order_earnings_checked_at?.trim() || null
  const error = row.ebay_order_earnings_error?.trim() || null
  const source = row.ebay_order_earnings_source?.trim() || null
  const currency = row.ebay_order_earnings_currency?.trim() || null

  let status: OrderFinanceSummary["status"]
  if (amount != null) status = "available"
  else if (!checkedAt) status = "missing"
  else if (error === "NOT_READY" || (!error && amount == null)) status = "not_ready"
  else if (error) status = "error"
  else status = "not_ready"

  return {
    ebayOrderEarnings:          amount,
    ebayOrderEarningsCurrency:  currency,
    ebayOrderEarningsSource:    source,
    ebayOrderEarningsCheckedAt: checkedAt,
    ebayOrderEarningsError:     error && error !== "NOT_READY" ? error : null,
    status,
    ebayGrossSales: null,
    amazonFinalCost: null,
    profit: null,
    profitPercent: null,
  }
}

async function persistEarnings(
  workspaceId: string,
  orderId:     number,
  fields: {
    amount:     number | null
    currency:   string | null
    source:     string | null
    error:      string | null
  }
): Promise<void> {
  await query(
    `UPDATE ebay_orders
     SET ebay_order_earnings = $3,
         ebay_order_earnings_currency = $4,
         ebay_order_earnings_source = $5,
         ebay_order_earnings_checked_at = NOW(),
         ebay_order_earnings_error = $6,
         updated_at = NOW()
     WHERE workspace_id = $1::uuid AND id = $2`,
    [
      workspaceId,
      orderId,
      fields.amount,
      fields.currency,
      fields.source,
      fields.error,
    ]
  )
}

type FetchDecision =
  | { action: "skip_present" }
  | { action: "skip_cooldown" }
  | { action: "fetch"; reason: "missing" | "not_ready" | "stale_after_update" | "retry_error" | "force" }

/**
 * Auto-sync decision (manual Yenile uses force=true and always fetches).
 *
 * Refund/update rule (when order_updated_at is reliable from eBay lastModifiedDate upsert):
 *   earnings filled AND order_updated_at <= checked_at → skip
 *   earnings filled AND order_updated_at > checked_at  → refresh once
 */
function decideAutoFetch(row: OrderEarningsDbRow, force: boolean): FetchDecision {
  if (force) return { action: "fetch", reason: "force" }

  const amount = parseMoney(row.ebay_order_earnings)
  const checkedAtMs = parseTs(row.ebay_order_earnings_checked_at)
  const updatedAtMs = parseTs(row.order_updated_at)
  const error = row.ebay_order_earnings_error?.trim() || null

  if (amount != null) {
    if (
      updatedAtMs != null
      && checkedAtMs != null
      && updatedAtMs > checkedAtMs
    ) {
      return { action: "fetch", reason: "stale_after_update" }
    }
    return { action: "skip_present" }
  }

  // No amount yet.
  if (error && error !== "NOT_READY" && checkedAtMs != null) {
    if (Date.now() - checkedAtMs < ERROR_RETRY_COOLDOWN_MS) {
      return { action: "skip_cooldown" }
    }
    return { action: "fetch", reason: "retry_error" }
  }

  if (error === "NOT_READY" || (checkedAtMs != null && amount == null)) {
    return { action: "fetch", reason: "not_ready" }
  }

  return { action: "fetch", reason: "missing" }
}

async function fetchAndPersistOne(
  workspaceId: string,
  row:         OrderEarningsDbRow,
  force:       boolean
): Promise<"saved" | "pending" | "failed" | "skipped_present" | "skipped_cooldown" | "refreshed_stale"> {
  const decision = decideAutoFetch(row, force)
  if (decision.action === "skip_present") return "skipped_present"
  if (decision.action === "skip_cooldown") return "skipped_cooldown"

  const ebayOrderId = (row.ebay_order_id || row.legacy_order_id || "").trim()
  if (!ebayOrderId) {
    await persistEarnings(workspaceId, row.id, {
      amount: null,
      currency: null,
      source: null,
      error: "missing_ebay_order_id",
    })
    return "failed"
  }

  let token: string
  try {
    token = await getValidAccessToken(workspaceId, row.store_code, false)
  } catch (e) {
    await persistEarnings(workspaceId, row.id, {
      amount: null,
      currency: null,
      source: null,
      error: e instanceof Error ? e.message.slice(0, 500) : "token_error",
    })
    return "failed"
  }

  const client = new EbayApiClient({
    oauthToken: token,
    sandbox: isEbaySandbox(),
    simulationMode: false,
  })
  const result = await client.getOrderEarnings(ebayOrderId)

  if (result.rawError && result.amount == null && !result.notReady) {
    await persistEarnings(workspaceId, row.id, {
      amount: null,
      currency: result.currency,
      source: result.source,
      error: result.rawError.slice(0, 500),
    })
    return "failed"
  }

  if (result.notReady && result.amount == null) {
    await persistEarnings(workspaceId, row.id, {
      amount: null,
      currency: result.currency,
      source: result.source,
      error: "NOT_READY",
    })
    return "pending"
  }

  await persistEarnings(workspaceId, row.id, {
    amount: result.amount,
    currency: result.currency,
    source: result.source,
    error: null,
  })

  if (decision.reason === "stale_after_update") return "refreshed_stale"
  return "saved"
}

/**
 * Manual Yenile — always hits eBay Finances (even when DB already has earnings).
 */
export async function refreshOrderEarnings(
  workspaceId: string,
  orderId:     number
): Promise<OrderDetail | null> {
  const res = await query<OrderEarningsDbRow>(
    `SELECT id, store_code, ebay_order_id, legacy_order_id,
            order_updated_at::text AS order_updated_at,
            ebay_order_earnings::text AS ebay_order_earnings,
            ebay_order_earnings_currency,
            ebay_order_earnings_source,
            ebay_order_earnings_checked_at::text AS ebay_order_earnings_checked_at,
            ebay_order_earnings_error
     FROM ebay_orders
     WHERE workspace_id = $1::uuid AND id = $2
     LIMIT 1`,
    [workspaceId, orderId]
  )
  const row = res.rows[0]
  if (!row) return null

  await fetchAndPersistOne(workspaceId, row, true)

  console.log(`${LOG} manual refresh`, {
    orderId,
    storeCode: row.store_code,
    ebayOrderId: row.ebay_order_id,
  })

  return getOrderDetail(workspaceId, orderId)
}

/**
 * Auto sync for orders returned by the same 24h lastModifiedDate fetch tick.
 * Only those ebay_order_id values — never scans all NULL earnings in DB.
 */
export async function syncOrderEarningsForEbayOrderIds(
  workspaceId:  string,
  storeCode:    string,
  ebayOrderIds: string[],
  storeId?:     number
): Promise<EarningsSyncStats> {
  const stats = emptyStats()
  const ids = [...new Set(
    ebayOrderIds.map((id) => id.trim()).filter((id) => id.length > 0)
  )]
  if (ids.length === 0) return stats

  const useStoreId = storeId != null && Number.isInteger(storeId) && storeId > 0
  const res = await query<OrderEarningsDbRow>(
    useStoreId
      ? `SELECT id, store_code, ebay_order_id, legacy_order_id,
            order_updated_at::text AS order_updated_at,
            ebay_order_earnings::text AS ebay_order_earnings,
            ebay_order_earnings_currency,
            ebay_order_earnings_source,
            ebay_order_earnings_checked_at::text AS ebay_order_earnings_checked_at,
            ebay_order_earnings_error
     FROM ebay_orders
     WHERE workspace_id = $1::uuid
       AND store_id = $2
       AND ebay_order_id = ANY($3::text[])`
      : `SELECT id, store_code, ebay_order_id, legacy_order_id,
            order_updated_at::text AS order_updated_at,
            ebay_order_earnings::text AS ebay_order_earnings,
            ebay_order_earnings_currency,
            ebay_order_earnings_source,
            ebay_order_earnings_checked_at::text AS ebay_order_earnings_checked_at,
            ebay_order_earnings_error
     FROM ebay_orders
     WHERE workspace_id = $1::uuid
       AND store_code = $2
       AND ebay_order_id = ANY($3::text[])`,
    useStoreId ? [workspaceId, storeId, ids] : [workspaceId, storeCode, ids]
  )

  for (const row of res.rows) {
    stats.earningsChecked++
    const outcome = await fetchAndPersistOne(workspaceId, row, false)
    if (outcome === "saved") stats.earningsSaved++
    else if (outcome === "pending") stats.earningsPending++
    else if (outcome === "failed") stats.earningsFailed++
    else if (outcome === "skipped_present") stats.earningsAlreadyPresent++
    else if (outcome === "skipped_cooldown") stats.earningsSkippedCooldown++
    else if (outcome === "refreshed_stale") {
      stats.earningsSaved++
      stats.earningsRefreshedStale++
    }
  }

  console.log(
    `${LOG} store=${storeCode} orders=${ids.length} ` +
    `checked=${stats.earningsChecked} saved=${stats.earningsSaved} ` +
    `existing=${stats.earningsAlreadyPresent} pending=${stats.earningsPending} ` +
    `failed=${stats.earningsFailed} cooldown=${stats.earningsSkippedCooldown} ` +
    `staleRefresh=${stats.earningsRefreshedStale}`
  )

  return stats
}
