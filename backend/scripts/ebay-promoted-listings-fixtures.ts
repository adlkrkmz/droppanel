import {
  parsePromotedRequest,
  ebayBidPercentage,
  promotionUserMessage,
  promotionRetryable,
  sanitizeMarketingError,
} from "../modules/ebay/ebayPromotedTypes"
import { parseCatalogStateId } from "../modules/listings/promotionPriceProtectionService"

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

const off = parsePromotedRequest({})
assert(off.ok && off.enabled === false, "default off")

const on = parsePromotedRequest({ promotedEnabled: true, promotedAdRate: 5 })
assert(on.ok && on.enabled && on.rate === 5, "rate 5")
assert(ebayBidPercentage(5) === "5.0", "ebay 5.0 not 0.05")

const dec = parsePromotedRequest({ promotedEnabled: true, promotedAdRate: 4.5 })
assert(dec.ok && dec.enabled && dec.rate === 4.5, "4.5")

assert(!parsePromotedRequest({ promotedEnabled: true, promotedAdRate: 1 }).ok, "min")
assert(!parsePromotedRequest({ promotedEnabled: true, promotedAdRate: 101 }).ok, "max")
assert(!parsePromotedRequest({ promotedEnabled: true, promotedAdRate: "" }).ok, "empty")
assert(!parsePromotedRequest({ promotedEnabled: true, promotedAdRate: "abc" }).ok, "text")

const bulk = [1, 2, 3].map(() => parsePromotedRequest({ promotedEnabled: true, promotedAdRate: 7 }))
assert(bulk.every(r => r.ok && r.enabled && r.rate === 7), "bulk shared rate")

assert(promotionUserMessage({ status: "FAILED", requested: true, code: "MARKETING_SCOPE_REQUIRED" }).includes("yenileyin"), "scope message")
assert(
  promotionUserMessage({
    status: "PENDING",
    requested: true,
    code: "NEW_LISTING_MARKETING_VISIBILITY_DELAY",
  }).includes("hazırlanıyor"),
  "visibility pending"
)
assert(promotionRetryable("PENDING", "NEW_LISTING_MARKETING_VISIBILITY_DELAY") === true, "visibility retryable")
assert(promotionRetryable("FAILED", "MARKETING_SCOPE_REQUIRED") === false, "scope not retryable")
assert(promotionRetryable("FAILED", "LISTING_NOT_ELIGIBLE") === false, "eligible not retryable")
assert(parseCatalogStateId("22346") === 22346, "bigint string catalog id")
assert(parseCatalogStateId(22346) === 22346, "numeric catalog id")
assert(Number.isFinite("22346" as unknown as number) === false, "raw string isFinite trap")
const vis = sanitizeMarketingError("The listing id does not exist", 35031)
assert(vis.code === "NEW_LISTING_MARKETING_VISIBILITY_DELAY" && vis.retryable, "35031 visibility")
const scope = sanitizeMarketingError("insufficient_scope sell.marketing")
assert(scope.code === "MARKETING_SCOPE_REQUIRED" && scope.retryable === false, "scope sanitize")
assert(parsePromotedRequest({}).ok && parsePromotedRequest({}).enabled === false, "unpromoted payload")

console.log("ebay-promoted-listings-fixtures PASS")
