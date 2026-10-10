import { query } from "../../db/client"
import { trustedFromBrowserVerificationRow, type TrustedAmazonReference } from "./keepaEvidencePolicy"

export { trustedFromBrowserVerificationRow }

type VerificationRow = {
  id: string
  asin: string
  result_price: string | null
  result_is_prime: boolean | null
  result_is_fba: boolean | null
  result_ships_from_amazon: boolean | null
  result_purchasable: string | null
  completed_at: Date
  last_verified_asin: string | null
  last_verified_decision: string | null
}

/** Latest COMPLETED browser/extension verification for this source ASIN. Not eBay, not Keepa CONFIRMED. */
export async function loadTrustedAmazonReference(asin: string): Promise<TrustedAmazonReference | null> {
  const key = asin.trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(key)) return null
  const res = await query<VerificationRow>(
    `SELECT t.id::text,
            t.asin,
            t.result_price::text,
            t.result_is_prime,
            t.result_is_fba,
            t.result_ships_from_amazon,
            t.result_purchasable,
            t.completed_at,
            scs.last_verified_asin,
            scs.last_verified_decision
     FROM amazon_price_verification_tasks t
     JOIN store_catalog_state scs ON scs.id = t.catalog_state_id
     WHERE t.asin = $1
       AND t.status = 'COMPLETED'
       AND NULLIF(BTRIM(COALESCE(t.worker_id, '')), '') IS NOT NULL
       AND t.failure_code IS NULL
       AND scs.last_verified_decision = 'VALID_SOURCE'
       AND UPPER(BTRIM(COALESCE(scs.last_verified_asin, t.asin))) = $1
       AND t.result_price IS NOT NULL
       AND t.result_price::numeric > 0
       AND COALESCE(t.result_purchasable, 'TRUE') NOT IN ('UNKNOWN', 'INCOMPLETE')
     ORDER BY t.completed_at DESC, t.id DESC
     LIMIT 1`,
    [key]
  )
  const row = res.rows[0]
  if (!row) return null
  return trustedFromBrowserVerificationRow({
    id: row.id,
    asin: row.asin,
    resultPrice: row.result_price,
    resultIsPrime: row.result_is_prime,
    resultIsFba: row.result_is_fba,
    resultShipsFromAmazon: row.result_ships_from_amazon,
    resultPurchasable: row.result_purchasable,
    completedAt: new Date(row.completed_at).toISOString(),
    lastVerifiedAsin: row.last_verified_asin,
    lastVerifiedDecision: row.last_verified_decision,
  })
}

export async function loadKeepaRegistryStatus(
  asin: string
): Promise<"ACTIVE" | "PAUSED_QTY_ZERO" | "REMOVED" | null> {
  const key = asin.trim().toUpperCase()
  const res = await query<{ status: string }>(
    `SELECT status FROM keepa_asin_sync_state WHERE asin = $1`,
    [key]
  )
  const status = String(res.rows[0]?.status ?? "").trim().toUpperCase()
  if (status === "ACTIVE" || status === "PAUSED_QTY_ZERO" || status === "REMOVED") return status
  return null
}
