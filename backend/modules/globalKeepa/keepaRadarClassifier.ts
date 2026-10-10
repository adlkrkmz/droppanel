import type { KeepaApiProduct } from "../keepa/keepaTypes"
import {
  extractKeepaRadarProductFields,
} from "./keepaRadarParser"
import type {
  GlobalKeepaPriceConfidence,
  GlobalKeepaRadarStatus,
  KeepaRadarClassification,
  KeepaRadarProductFields,
} from "./globalKeepaTypes"

export type PreviousKeepaRadarPrice = {
  newPriceUsd: number | null
}

function pricesEqual(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a === b
  return Math.abs(a - b) < 0.001
}

function classifyPresentProduct(
  fields: KeepaRadarProductFields,
  previous?: PreviousKeepaRadarPrice | null
): KeepaRadarClassification {
  const fba = fields.newFbaCount
  const fbm = fields.newFbmCount
  const newPrice = fields.newPriceUsd

  if (fba == null && fbm == null && newPrice == null) {
    return { status: "PRICE_AMBIGUOUS", priceConfidence: "NONE", fields }
  }

  if (fba === 0) {
    return { status: "FBA_MISSING", priceConfidence: "NONE", fields }
  }

  if (fba != null && fba > 0 && fbm != null && fbm > 0) {
    return { status: "PRICE_AMBIGUOUS", priceConfidence: "AMBIGUOUS", fields }
  }

  if (fba != null && fba > 0) {
    if (previous && previous.newPriceUsd != null && newPrice != null && newPrice > 0) {
      const status: GlobalKeepaRadarStatus = pricesEqual(previous.newPriceUsd, newPrice)
        ? "PRICE_UNCHANGED"
        : "PRICE_CHANGED"
      return { status, priceConfidence: "CONFIRMED_FBA", fields }
    }
    return { status: "FBA_PRESENT", priceConfidence: "CONFIRMED_FBA", fields }
  }

  if (newPrice != null && newPrice > 0 && (fba == null || fbm == null)) {
    return { status: "PRICE_AMBIGUOUS", priceConfidence: "AMBIGUOUS", fields }
  }

  return { status: "PRICE_AMBIGUOUS", priceConfidence: "AMBIGUOUS", fields }
}

/**
 * Signal-only classifier. Never maps PRODUCT_NOT_RETURNED to REMOVED / OUT_OF_STOCK.
 * Not wired to Stock Guard or eBay mutations.
 */
export function classifyKeepaRadarProduct(input: {
  requestedAsin: string
  product: KeepaApiProduct | null | undefined
  previous?: PreviousKeepaRadarPrice | null
  checkFailed?: boolean
}): KeepaRadarClassification {
  if (input.checkFailed) {
    return { status: "CHECK_FAILED", priceConfidence: "FAILED", fields: null }
  }

  const requested = input.requestedAsin.trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(requested)) {
    return { status: "CHECK_FAILED", priceConfidence: "FAILED", fields: null }
  }

  if (!input.product) {
    return { status: "PRODUCT_NOT_RETURNED", priceConfidence: "NONE", fields: null }
  }

  const fields = extractKeepaRadarProductFields(input.product)
  if (!fields || fields.asin !== requested) {
    return { status: "PRODUCT_NOT_RETURNED", priceConfidence: "NONE", fields: null }
  }

  return classifyPresentProduct(fields, input.previous)
}
