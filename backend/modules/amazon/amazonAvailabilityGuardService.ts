// ----------------------------------------------------------------
// amazonAvailabilityGuardService.ts — DB-backed availability evaluation
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { normalizePoolId } from "../pool/poolEligibilityService"
import {
  asBool,
  asRecord,
  normalizeAmazonAvailabilitySignals,
  type AmazonAvailabilityInput,
  type AmazonAvailabilityResult,
} from "./amazonAvailabilityGuardCore"

export * from "./amazonAvailabilityGuardCore"

export async function loadAmazonAvailabilityInputForPool(
  workspaceId: string,
  poolId:      number
): Promise<AmazonAvailabilityInput | null> {
  const id = normalizePoolId(poolId)
  if (id == null) return null

  const result = await query<{
    asin:       string | null
    price:      number | null
    source:     string | null
    attributes: unknown
  }>(
    `SELECT ar.asin, apc.price, apc.source, apc.attributes
     FROM asin_pool ap
     LEFT JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     LEFT JOIN amazon_product_cache apc ON apc.asin_registry_id = ap.asin_registry_id
     WHERE ap.workspace_id = $1 AND ap.id = $2
     LIMIT 1`,
    [workspaceId, id]
  )

  const row = result.rows[0]
  if (!row) return null

  const attrs = asRecord(row.attributes) ?? {}

  return {
    asin:             row.asin,
    cacheSource:      row.source,
    source:           typeof attrs.source === "string" ? attrs.source : row.source,
    isPrime:          asBool(attrs.isPrime),
    primeStatus:      typeof attrs.primeStatus === "string" ? attrs.primeStatus : null,
    stockStatus:      typeof attrs.stockStatus === "string" ? attrs.stockStatus : null,
    stockCount:       typeof attrs.stockCount === "number" ? attrs.stockCount
      : (typeof attrs.stockCount === "string" ? Number(attrs.stockCount) || null : null),
    availabilityText: typeof attrs.availabilityText === "string" ? attrs.availabilityText : null,
    hasAddToCart:     asBool(attrs.hasAddToCart),
    hasBuyNow:        asBool(attrs.hasBuyNow),
    price:            row.price != null ? Number(row.price) : null,
    attributes:       attrs,
  }
}

export async function evaluatePoolAmazonAvailability(
  workspaceId: string,
  poolId:      number,
  asinHint?:   string | null
): Promise<AmazonAvailabilityResult> {
  const input = await loadAmazonAvailabilityInputForPool(workspaceId, poolId)
  if (!input) {
    return normalizeAmazonAvailabilitySignals({ asin: asinHint ?? null })
  }
  if (!input.asin && asinHint) input.asin = asinHint
  return normalizeAmazonAvailabilitySignals(input)
}
