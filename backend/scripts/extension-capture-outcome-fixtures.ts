import { summarizeExtensionCaptureOutcome } from "../modules/extensionCapture/extensionCaptureOutcome"

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

const published = summarizeExtensionCaptureOutcome({ itemStatus: "published", listingId: "123" })
assert(published.ok && published.status === "uploaded" && published.retryable === false, "published")

const sku = summarizeExtensionCaptureOutcome({
  itemStatus: "failed",
  errorMessage: "",
})
assert(sku.status === "failed", "empty failed")

const dbOffer = summarizeExtensionCaptureOutcome({
  itemStatus: "failed",
  errorMessage: 'publishOffer failed: HTTP 400 - {"errors":[{"errorId":25019,"message":"improper words / profanity"}]}',
})
assert(dbOffer.code === "EBAY_25019" && dbOffer.retryable === false && dbOffer.message.includes("politika"), "25019")

const skuLookup = summarizeExtensionCaptureOutcome({
  itemStatus: "failed",
  errorMessage: 'publishOffer failed: HTTP 500 - {"errors":[{"errorId":25002,"message":"System error. Please try again later."}]}',
})
assert(skuLookup.retryable === true && skuLookup.code === "EBAY_25002", "25002")

const listing = summarizeExtensionCaptureOutcome({ itemStatus: "skipped_duplicate" })
assert(listing.alreadyExists && listing.status === "already_exists" && listing.retryable === false, "dup")

const queued = summarizeExtensionCaptureOutcome({ itemStatus: "queued_for_publish" })
assert(queued.status === "queued" && queued.ok, "queued")

const timeout = summarizeExtensionCaptureOutcome({ itemStatus: "failed", errorMessage: "aborted timeout Failed to fetch" })
assert(timeout.status === "unknown" && timeout.retryable, "timeout")

const stockGate = summarizeExtensionCaptureOutcome({
  itemStatus: "capture_blocked",
  errorMessage: "STOCK_UNKNOWN: Explicit selected-offer stock status could not be verified",
})
assert(stockGate.code === "STOCK_UNKNOWN" && stockGate.message.includes("stok durumu") && stockGate.retryable === false, "stock gate is not capture failed")

const limitedStockGate = summarizeExtensionCaptureOutcome({
  itemStatus: "capture_blocked",
  errorMessage: "LIMITED_STOCK: Only 13 left in stock",
})
assert(limitedStockGate.code === "LIMITED_STOCK" && limitedStockGate.message.includes("sınırlı stok"), "limited stock gate")

const primeGate = summarizeExtensionCaptureOutcome({
  itemStatus: "capture_blocked",
  errorMessage: "PRIME_UNKNOWN: Explicit Prime eligibility could not be verified",
})
assert(primeGate.code === "PRIME_UNKNOWN" && primeGate.message.includes("Prime"), "prime gate keeps reason")

const outOfStockGate = summarizeExtensionCaptureOutcome({
  itemStatus: "capture_blocked",
  errorMessage: "OUT_OF_STOCK: Product is out of stock on Amazon",
})
assert(outOfStockGate.code === "OUT_OF_STOCK" && outOfStockGate.message.includes("stokta yok"), "out of stock gate keeps reason")

console.log("extension-capture-outcome-fixtures PASS")
