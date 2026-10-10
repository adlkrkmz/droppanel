import { query } from "../../db/client"
import { GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE } from "./globalKeepaEligibility"

export function keepaTechnicalFailureUserReason(code: string | null | undefined): string {
  const c = String(code ?? "").trim().toUpperCase()
  if (c === "HTTP_429") return "Keepa rate limit"
  if (c === "TIMEOUT") return "Keepa timeout"
  if (c.includes("TOKEN")) return "Keepa token shortage"
  if (c === "HTTP_5XX") return "Keepa server error"
  if (c === "NETWORK") return "Keepa network error"
  if (c === "MALFORMED_JSON") return "Keepa malformed response"
  return "Keepa check failed"
}

/**
 * My Listings current-state sync for technical Keepa failures.
 * Never nulls source_price / last accepted Amazon price.
 * Fan-out only to eligible consumers (qty>0, live, Guard on, source ASIN present).
 */
export async function syncEligibleListingsKeepaCheckFailed(input: {
  globalAsinId: number
  reasonCode?: string | null
}): Promise<void> {
  const reason = keepaTechnicalFailureUserReason(input.reasonCode)
  await query(
    `UPDATE store_catalog_state scs
     SET source_status = CASE
           WHEN scs.source_status IS DISTINCT FROM 'CHECK_FAILED' THEN 'CHECK_FAILED'
           ELSE scs.source_status
         END,
         source_status_reason = CASE
           WHEN scs.source_status IS DISTINCT FROM 'CHECK_FAILED' THEN $2::text
           ELSE scs.source_status_reason
         END,
         source_checked_at = NOW(),
         updated_at = NOW()
     FROM global_asin_consumers c
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     WHERE c.global_asin_id = $1::bigint
       AND scs.id = c.catalog_state_id
       AND ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE}`,
    [input.globalAsinId, reason]
  )
}
