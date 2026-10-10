import {
  deriveIsFba,
  derivePurchasable,
  shipsFromAmazon,
  soldByAmazon,
} from "../amazonVerification/amazonVerificationNormalize"
import type { AmazonExtractOk } from "./amazonPageExtract"

export type OfferPrimeFbaSignals = {
  isPrime: boolean | null
  isFba: boolean | null
  shipsFromAmazon: boolean | null
  soldByAmazon: boolean | null
  purchasable: "TRUE" | "FALSE" | "UNKNOWN"
  buyBoxFullyReadable: boolean
  /**
   * Merchant fulfillment chrome readable enough to evaluate Ships-from.
   * Price/Prime alone must NOT mark healthy (avoids false NOT_FBA).
   */
  offerPageHealthy: boolean
}

function isOfferPageHealthy(data: AmazonExtractOk["data"]): boolean {
  if (data.pageUnavailable === true) return false
  if (data.captcha === true) return false
  // Fail-safe: without readable merchant bits, do not treat page as healthy
  // for destructive fulfillment decisions (NOT_FBA).
  const hasMerchantBits =
    Boolean(String(data.shipsFrom ?? "").trim()) || Boolean(String(data.soldBy ?? "").trim())
  return hasMerchantBits
}

/**
 * Map page extract → Prime / Ships-from-Amazon / stock signals.
 * Explicit non-Amazon Ships-from → isFba false.
 * Null/unknown Ships-from stays null (SHIPPER_UNKNOWN downstream) — never coerce to false
 * just because price/Prime loaded.
 */
export function evaluateOfferPrimeFbaSignals(data: AmazonExtractOk["data"]): OfferPrimeFbaSignals {
  const sold = soldByAmazon(data.soldBy)
  const ships = shipsFromAmazon(data.shipsFrom)
  const offerPageHealthy = isOfferPageHealthy(data)

  const isFba = deriveIsFba({
    shipsFromAmazon: ships,
    soldByAmazon: sold,
  })

  const purchasable = derivePurchasable({
    hasAddToCart: data.hasAddToCart,
    hasBuyNow: data.hasBuyNow,
    availabilityText: data.availabilityText,
    stockStatus: data.stockStatus,
  })
  const hasMerchant =
    Boolean(String(data.shipsFrom ?? "").trim()) || Boolean(String(data.soldBy ?? "").trim())
  const hasPurchaseSignal =
    data.hasAddToCart === true ||
    data.hasBuyNow === true ||
    data.stockStatus === "IN_STOCK" ||
    data.stockStatus === "LIMITED_STOCK"
  const hasPrice = data.displayedPrice != null && data.displayedPrice > 0
  const buyBoxFullyReadable =
    (hasPrice || hasPurchaseSignal) && hasMerchant && purchasable !== "UNKNOWN"

  return {
    isPrime: data.isPrime,
    isFba,
    shipsFromAmazon: ships,
    soldByAmazon: sold,
    purchasable,
    buyBoxFullyReadable,
    offerPageHealthy,
  }
}
