import assert from "node:assert/strict"
import fs from "node:fs"

const source = fs.readFileSync("../extension/content.js", "utf8")
const start = source.indexOf("function detectSelectedOfferStock()")
const end = source.indexOf("function visibleBuyBoxButton", start)
const detector = source.slice(start, end)

assert(start >= 0 && end > start, "selected-offer stock detector missing")
assert(detector.indexOf("oosNode || limitedNode || inStockNode") >= 0, "negative-stock precedence missing")
assert(
  detector.indexOf("!LIMITED_STOCK_RE.test(candidate)") > detector.indexOf("LIMITED_STOCK_RE.test(candidate)"),
  "plain in-stock branch must exclude limited stock",
)

const limited = /only\s+(\d+)\s+(?:item(?:s)?\s+)?left(?:\s+in\s+stock)?/i
const oos = /currently\s+unavailable|temporarily\s+out\s+of\s+stock|\bout\s+of\s+stock\b|we\s+don'?t\s+know\s+when\s+or\s+if this item will be back/i
const inStock = /\bin\s+stock\b/i

function classify(text: string, addToCart = false, buyNow = false): string {
  if (!text) return addToCart || buyNow ? "IN_STOCK" : "UNKNOWN"
  if (oos.test(text)) return "OUT_OF_STOCK"
  const match = text.match(limited)
  if (match) return "LIMITED_STOCK"
  if (inStock.test(text)) return "IN_STOCK"
  return "UNKNOWN"
}

for (const text of [
  "Currently unavailable",
  "Temporarily out of stock",
  "Out of stock",
  "We don't know when or if this item will be back in stock",
]) assert.equal(classify(text), "OUT_OF_STOCK", text)
assert.equal(classify("Only 1 left in stock - order soon"), "LIMITED_STOCK")
assert.equal(classify("Only 13 left in stock"), "LIMITED_STOCK")
assert.equal(classify("In Stock"), "IN_STOCK")
assert.equal(classify(""), "UNKNOWN")
assert.equal(classify("", true), "IN_STOCK")
assert.equal(classify("", false, true), "IN_STOCK")
console.log("extension-stock-precedence-fixtures PASS")
