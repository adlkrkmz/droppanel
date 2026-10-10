/**
 * Dry-run fixtures for amazonAvailabilityGuardService.
 * Run: npx ts-node --transpile-only scripts/amazon-availability-fixtures.ts
 */

import assert from "node:assert/strict"

import {
  normalizeAmazonAvailabilitySignals,
  resolveDirectListAvailabilitySkipReason,
  resolveAvailabilitySkipReason,
  type AmazonAvailabilityInput,
} from "../modules/amazon/amazonAvailabilityGuardCore"

type Fixture = {
  name:     string
  input:    AmazonAvailabilityInput
  expected: { prime: string; stock: string; price: string; stockCount?: number | null }
}

const fixtures: Fixture[] = [
  {
    name: "A) Prime + in stock + price",
    input: {
      asin: "B0TEST0001",
      source: "extension",
      isPrime: true,
      primeStatus: "PRIME",
      hasAddToCart: true,
      availabilityText: "In Stock",
      stockStatus: "IN_STOCK",
      price: 6.99,
    },
    expected: { prime: "PRIME", stock: "IN_STOCK", price: "VALID_PRICE", stockCount: null },
  },
  {
    name: "B) Currently unavailable",
    input: {
      asin: "B072ZV2M29",
      source: "extension",
      availabilityText: "Currently unavailable. We don't know when or if this item will be back in stock.",
      hasAddToCart: false,
      hasBuyNow: false,
    },
    expected: { prime: "PRIME_UNKNOWN", stock: "OUT_OF_STOCK", price: "PRICE_UNKNOWN" },
  },
  {
    name: "C) Cache missing",
    input: {},
    expected: { prime: "PRIME_UNKNOWN", stock: "STOCK_UNKNOWN", price: "PRICE_UNKNOWN" },
  },
  {
    name: "D) isPrime null",
    input: { attributes: { isPrime: null }, source: "extension" },
    expected: { prime: "PRIME_UNKNOWN", stock: "STOCK_UNKNOWN", price: "PRICE_UNKNOWN" },
  },
  {
    name: "E) isPrime false trusted — ATC alone is not IN_STOCK",
    input: { isPrime: false, source: "live_extract", price: 12.99, hasAddToCart: true },
    expected: { prime: "NOT_PRIME", stock: "STOCK_UNKNOWN", price: "VALID_PRICE" },
  },
  {
    name: "F) isPrime false simulation",
    input: { isPrime: false, source: "simulation", price: 12.99 },
    expected: { prime: "PRIME_UNKNOWN", stock: "STOCK_UNKNOWN", price: "VALID_PRICE" },
  },
  {
    name: "G) Only N left → LIMITED_STOCK (not IN_STOCK)",
    input: {
      asin: "B0D436YVRZ",
      source: "extension",
      isPrime: true,
      primeStatus: "PRIME",
      hasAddToCart: true,
      availabilityText: "Only 12 left in stock - order soon.",
      price: 19.99,
    },
    expected: { prime: "PRIME", stock: "LIMITED_STOCK", price: "VALID_PRICE", stockCount: 12 },
  },
  {
    name: "H) B072ZV2M29 unavailable",
    input: {
      asin: "B072ZV2M29",
      source: "extension",
      availabilityText: "Currently unavailable",
      hasAddToCart: false,
    },
    expected: { prime: "PRIME_UNKNOWN", stock: "OUT_OF_STOCK", price: "PRICE_UNKNOWN" },
  },
  {
    name: "I) Normal In Stock",
    input: {
      asin: "B0DS4RMGTQ",
      source: "extension",
      primeStatus: "PRIME",
      isPrime: true,
      availabilityText: "In Stock",
      stockStatus: "IN_STOCK",
      price: 9.99,
      hasAddToCart: true,
    },
    expected: { prime: "PRIME", stock: "IN_STOCK", price: "VALID_PRICE", stockCount: null },
  },
  {
    name: "J) Explicit LIMITED_STOCK + isInStock-style ATC",
    input: {
      asin: "B0LIMIT001",
      source: "extension",
      primeStatus: "PRIME",
      stockStatus: "LIMITED_STOCK",
      stockCount: 5,
      hasAddToCart: true,
      availabilityText: "Only 5 left in stock",
      price: 11,
    },
    expected: { prime: "PRIME", stock: "LIMITED_STOCK", price: "VALID_PRICE", stockCount: 5 },
  },
]

let passed = 0
let failed = 0

for (const f of fixtures) {
  const r = normalizeAmazonAvailabilitySignals(f.input)
  const stockCountOk =
    f.expected.stockCount === undefined
    || r.stockCount === f.expected.stockCount
  const ok =
    r.primeStatus === f.expected.prime &&
    r.stockStatus === f.expected.stock &&
    r.priceStatus === f.expected.price &&
    stockCountOk

  if (ok) {
    passed++
    console.log(`✓ ${f.name}`)
  } else {
    failed++
    console.error(`✗ ${f.name}`, {
      expected: f.expected,
      got: { prime: r.primeStatus, stock: r.stockStatus, stockCount: r.stockCount, price: r.priceStatus },
    })
  }
}

console.log(`\n${passed}/${fixtures.length} passed`)
if (failed > 0) process.exit(1)

const directListUnknown = normalizeAmazonAvailabilitySignals({
  asin: "B0TEST0002", source: "extension", primeStatus: "PRIME", isPrime: true,
  stockStatus: "UNKNOWN", price: 12.99,
})
assert.equal(resolveAvailabilitySkipReason(directListUnknown), "STOCK_UNKNOWN")
assert.equal(resolveDirectListAvailabilitySkipReason(directListUnknown), null)
assert.equal(resolveDirectListAvailabilitySkipReason(normalizeAmazonAvailabilitySignals({
  source: "extension", primeStatus: "PRIME", isPrime: true, stockStatus: "OUT_OF_STOCK", price: 12.99,
})), "OUT_OF_STOCK")
assert.equal(resolveDirectListAvailabilitySkipReason(normalizeAmazonAvailabilitySignals({
  source: "extension", primeStatus: "PRIME", isPrime: true, stockStatus: "LIMITED_STOCK", price: 12.99,
})), "LIMITED_STOCK")
assert.equal(resolveDirectListAvailabilitySkipReason(normalizeAmazonAvailabilitySignals({
  source: "extension", primeStatus: "NOT_PRIME", stockStatus: "UNKNOWN", price: 12.99,
})), "NOT_PRIME")
assert.equal(resolveDirectListAvailabilitySkipReason(normalizeAmazonAvailabilitySignals({
  source: "extension", primeStatus: "PRIME", isPrime: true, stockStatus: "UNKNOWN", price: 0,
})), "NO_VALID_PRICE")
const asinMismatch = normalizeAmazonAvailabilitySignals({
  asin: "B0TEST0003", source: "extension", primeStatus: "PRIME", isPrime: true,
  stockStatus: "UNKNOWN", price: 12.99, attributes: { selectedAsin: "B0OTHER000" },
})
assert.equal(asinMismatch.primeStatus, "PRIME_UNKNOWN")
assert(asinMismatch.evidence.includes("ASIN_MISMATCH"))
assert.equal(resolveDirectListAvailabilitySkipReason(asinMismatch), "PRIME_UNKNOWN")
console.log("PASS Direct List STOCK_UNKNOWN-only allowance")
