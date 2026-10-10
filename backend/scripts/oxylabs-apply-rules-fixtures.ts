import assert from "assert"
import fs from "fs"
import path from "path"
import { classifyVerifiedAmazonSource, isAutomaticZeroDecisionSafe } from "../modules/amazonVerification/verifiedSourceDecision"
import { calculateListingPrice, BUYER_TAX_RATE_ASSUMPTION, EBAY_FINAL_VALUE_FEE_RATE, EBAY_FIXED_ORDER_FEE } from "../modules/pricing/pricingService"
import { planVerifiedStockAction } from "../modules/stockGuard/verifiedStockActionPlan"
import { classifySourceApplyGuard, isV2KeepaMonitorEligible, stockZeroIdempotencyKey, profitProtectionIdempotencyKey } from "../modules/globalKeepa/sourceAsinLifecycle"
import {
  decideOxylabsSingleQuery,
  mapOxylabsToVerifiedDecision,
  oxylabsIdentityOutcome,
  shouldEnqueueOxylabsConfirm,
} from "../modules/oxylabsVerify/oxylabsProductDecision"
import { normalizeOxylabsAmazonProduct } from "../modules/oxylabsVerify/oxylabsProductNormalize"
import { oxylabsOperationKey } from "../modules/oxylabsVerify/oxylabsProductDecision"

function wrap(content: Record<string, unknown>, status = 200): Record<string, unknown> {
  return { results: [{ content, status_code: status, parse_status_code: 12000 }] }
}

const amazonFeatured = {
  name: "Amazon.com",
  seller_id: "ATVPDKIKX0DER",
  is_amazon_fulfilled: true,
  is_prime_eligible: true,
  shipped_from: "Amazon.com",
}

function primeBuybox(price: number, stock = "In Stock") {
  return [
    {
      price,
      stock,
      seller_name: "Amazon.com",
      delivery_details: [{ type: "Prime members" }],
    },
  ]
}

type Listing = {
  live: boolean
  qty: number
  sourceAsin: string
  stockGuard: boolean
  ebayItemId: string
  trusted: number | null
  lastVerifiedAsin: string | null
  lastVerifiedDecision: string | null
  ebayPrice: number | null
}

function dryRun(input: {
  requested: string
  payload: Record<string, unknown>
  panelPrice: number | null
  listing: Listing
  mutations: boolean
}) {
  const n = normalizeOxylabsAmazonProduct({ requestedAsin: input.requested, payload: input.payload })
  const d = decideOxylabsSingleQuery({
    n,
    panel: {
      sourceAsin: input.listing.sourceAsin,
      sourcePrice: input.panelPrice,
      listingLive: input.listing.live,
      qty: input.listing.qty,
    },
    mutationsEnabled: input.mutations,
  })
  const v = mapOxylabsToVerifiedDecision({ n, productClass: d.productClass, code: d.evidenceCode })
  const monitorEligible = isV2KeepaMonitorEligible({
    currentStatus: input.listing.live ? "live" : "ended",
    stockGuardEnabled: input.listing.stockGuard,
    ebayItemId: input.listing.ebayItemId,
    ebayQuantity: input.listing.qty,
    sourceAsin: input.listing.sourceAsin,
  })
  const guard = classifySourceApplyGuard({
    taskAsin: input.requested,
    currentSourceAsin: input.listing.sourceAsin,
    consumerAsin: input.requested,
    listingLive: input.listing.live,
    stockGuardEnabled: input.listing.stockGuard,
    monitorEligible,
    ebayQuantity: input.listing.qty,
  })
  const plan = planVerifiedStockAction({
    decision: v,
    settings: { enabled: true, mode: "auto", priceAlertEnabled: true, autoProfitProtectionEnabled: true },
    currentEbayQuantity: input.listing.qty,
    trustedBaselinePrice: input.listing.trusted,
    lastVerifiedDecision: input.listing.lastVerifiedDecision,
    verifiedActionsEnabled: true,
    lastVerifiedAsin: input.listing.lastVerifiedAsin,
    currentSourceAsin: input.listing.sourceAsin,
  })
  const zeroSafe = isAutomaticZeroDecisionSafe(v)
  const wouldZero =
    input.mutations && d.applyMutation && guard.ok && plan.action === "zero_stock" && zeroSafe
  const wouldPrice =
    input.mutations && d.applyMutation && guard.ok && plan.action === "profit_protection"
  const domainApply = wouldZero
    ? "applyConfirmedNoValidSource"
    : wouldPrice
      ? "applyAcceptedSourcePrice"
      : null
  return { n, d, v, guard, plan, zeroSafe, wouldZero, wouldPrice, domainApply, identity: oxylabsIdentityOutcome(n) }
}

const listing = (asin: string, extra: Partial<Listing> = {}): Listing => ({
  live: true,
  qty: 1,
  sourceAsin: asin,
  stockGuard: true,
  ebayItemId: "111",
  trusted: 19.99,
  lastVerifiedAsin: asin,
  lastVerifiedDecision: "VALID_SOURCE",
  ebayPrice: 33.31,
  ...extra,
})

const sameAsinOffer = (asin: string, price: number, stock = "In Stock") =>
  wrap({
    url: `https://www.amazon.com/dp/${asin}`,
    asin,
    asin_in_url: asin,
    title: "Widget",
    price,
    currency: "USD",
    stock,
    condition: "NEW",
    featured_merchant: amazonFeatured,
    buybox: primeBuybox(price, stock),
  })

function offerWith(featured: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return wrap({
    url: "https://www.amazon.com/dp/B00TEST001",
    asin: "B00TEST001",
    asin_in_url: "B00TEST001",
    title: "Widget",
    price: 19.99,
    currency: "USD",
    stock: "In Stock",
    condition: "NEW",
    featured_merchant: featured,
    ...extra,
  })
}

const liveListing = listing("B00TEST001")

// 1. Prime true + AFN true + Amazon shipper → valid
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: sameAsinOffer("B00TEST001", 19.99),
    panelPrice: 19.99,
    listing: liveListing,
    mutations: true,
  })
  assert.equal(r.n.primeEvidence, "EXPLICIT_TRUE")
  assert.equal(r.n.isAmazonFulfilled, true)
  assert.equal(r.n.shipsFromAmazon, true)
  assert.equal(r.v.outcome, "VALID_SOURCE")
  assert.equal(r.d.audit, "NO_BUSINESS_CHANGE")
  assert.equal(r.domainApply, null)
  const browser = classifyVerifiedAmazonSource({
    requestedAsin: "B00TEST001",
    finalAsin: "B00TEST001",
    displayedPrice: 19.99,
    isPrime: true,
    isFba: true,
    shipsFromAmazon: true,
    availabilityText: "In Stock",
    stockStatus: "IN_STOCK",
    condition: "NEW",
  })
  assert.equal(browser.outcome, "VALID_SOURCE")
}

// 2. Prime false + AFN true remains valid; Prime is not a standalone zero trigger.
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: offerWith({
      name: "Amazon.com",
      seller_id: "ATVPDKIKX0DER",
      is_amazon_fulfilled: true,
      is_prime_eligible: false,
      shipped_from: "Amazon.com",
    }),
    panelPrice: 19.99,
    listing: liveListing,
    mutations: true,
  })
  assert.equal(r.n.primeEvidence, "EXPLICIT_FALSE")
  assert.equal(r.d.productClass, "VALID_SOURCE")
  assert.equal(r.v.outcome, "VALID_SOURCE")
  assert.equal(r.zeroSafe, false)
  assert.notEqual(r.domainApply, "applyConfirmedNoValidSource")
  const browser = classifyVerifiedAmazonSource({
    requestedAsin: "B00TEST001",
    finalAsin: "B00TEST001",
    displayedPrice: 19.99,
    isPrime: false,
    isFba: true,
    shipsFromAmazon: true,
    availabilityText: "In Stock",
    stockStatus: "IN_STOCK",
    condition: "NEW",
  })
  assert.equal(browser.code, "NOT_PRIME")
  assert.equal(isAutomaticZeroDecisionSafe(browser), true)
}

// 3. Prime true + AFN false + non-Amazon shipper → NOT_FBA → zero
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: offerWith({
      name: "Other Seller",
      seller_id: "A1SELLERXX",
      is_amazon_fulfilled: false,
      is_prime_eligible: true,
      shipped_from: "Other Seller",
    }),
    panelPrice: 19.99,
    listing: liveListing,
    mutations: true,
  })
  assert.equal(r.d.audit, "NOT_FBA")
  assert.equal(r.v.code, "NOT_FBA")
  assert.equal(r.v.outcome, "CONFIRMED_NO_VALID_SOURCE")
  assert.equal(r.domainApply, "applyConfirmedNoValidSource")
  const browser = classifyVerifiedAmazonSource({
    requestedAsin: "B00TEST001",
    finalAsin: "B00TEST001",
    displayedPrice: 19.99,
    isPrime: true,
    isFba: false,
    shipsFromAmazon: false,
    availabilityText: "In Stock",
    stockStatus: "IN_STOCK",
    condition: "NEW",
  })
  assert.equal(browser.code, "NOT_FBA")
  assert.equal(isAutomaticZeroDecisionSafe(browser), true)
}

// 4. Prime null → unknown, mutation 0
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: offerWith({
      name: "Amazon.com",
      seller_id: "ATVPDKIKX0DER",
      is_amazon_fulfilled: true,
      shipped_from: "Amazon.com",
    }),
    panelPrice: 19.99,
    listing: liveListing,
    mutations: true,
  })
  assert.equal(r.n.primeEvidence, "UNKNOWN")
  assert.equal(r.d.audit, "PRODUCT_INCONCLUSIVE")
  assert.equal(r.d.evidenceCode, "PRIME_UNKNOWN")
  assert.equal(r.v.outcome, "UNKNOWN")
  assert.equal(r.wouldZero, false)
  assert.equal(r.domainApply, null)
}

// 5. AFN null + shipper null → unknown (after Prime true)
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: offerWith({
      name: "Some Seller",
      seller_id: "A1SELLERXX",
      is_prime_eligible: true,
    }),
    panelPrice: 19.99,
    listing: liveListing,
    mutations: true,
  })
  assert.equal(r.n.isAmazonFulfilled, null)
  assert.equal(r.n.shipsFromAmazon, null)
  assert.equal(r.d.evidenceCode, "AFN_SHIPPER_UNKNOWN")
  assert.equal(r.wouldZero, false)
  assert.equal(r.domainApply, null)
}

// 6. AFN true + Amazon shipper + third-party seller → valid
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: offerWith({
      name: "MBX Corp",
      seller_id: "A1OPF31LFC3IB3",
      is_amazon_fulfilled: true,
      is_prime_eligible: true,
      shipped_from: "Amazon",
    }),
    panelPrice: 19.99,
    listing: liveListing,
    mutations: true,
  })
  assert.equal(r.v.outcome, "VALID_SOURCE")
  assert.equal(r.d.audit, "NO_BUSINESS_CHANGE")
  assert.equal(r.domainApply, null)
}

// 7. AFN false + shipper Amazon → contradiction, mutation 0
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: offerWith({
      name: "X",
      seller_id: "A1",
      is_amazon_fulfilled: false,
      is_prime_eligible: true,
      shipped_from: "Amazon",
    }),
    panelPrice: 19.99,
    listing: liveListing,
    mutations: true,
  })
  assert.equal(r.d.evidenceCode, "AFN_SHIPPER_CONTRADICTION")
  assert.equal(r.wouldZero, false)
  assert.equal(r.domainApply, null)
}

// 8. AFN true + non-Amazon shipper → contradiction, mutation 0
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: offerWith({
      name: "X",
      seller_id: "A1",
      is_amazon_fulfilled: true,
      is_prime_eligible: true,
      shipped_from: "Other Warehouse",
    }),
    panelPrice: 19.99,
    listing: liveListing,
    mutations: true,
  })
  assert.equal(r.d.evidenceCode, "AFN_SHIPPER_CONTRADICTION")
  assert.equal(r.wouldZero, false)
}

// 1. requested=returned, same price → no-op
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: sameAsinOffer("B00TEST001", 19.99),
    panelPrice: 19.99,
    listing: listing("B00TEST001"),
    mutations: true,
  })
  assert.equal(r.identity.code, "MATCH")
  assert.equal(r.d.audit, "NO_BUSINESS_CHANGE")
  assert.equal(r.d.evidenceCode, "PRICE_MATCH")
  assert.equal(r.v.outcome, "VALID_SOURCE")
  assert.equal(r.wouldZero, false)
  assert.equal(r.wouldPrice, false)
  assert.equal(r.d.applyMutation, false)
}

// 2. requested≠returned, URL still requested → source invalid / zero stock
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: wrap({
      url: "https://www.amazon.com/dp/B00TEST001",
      asin: "B00OTHER99",
      asin_in_url: "B00TEST001",
      title: "Variant",
      price: 9.99,
      currency: "USD",
      stock: "In Stock",
      featured_merchant: amazonFeatured,
      buybox: primeBuybox(9.99),
    }),
    panelPrice: 19.99,
    listing: listing("B00TEST001"),
    mutations: true,
  })
  assert.equal(r.identity.code, "ASIN_IDENTITY_CHANGED")
  assert.equal(r.d.audit, "ASIN_IDENTITY_CHANGED")
  assert.equal(r.v.outcome, "CONFIRMED_NO_VALID_SOURCE")
  assert.equal(r.v.code, "SOURCE_ASIN_MISMATCH")
  assert.equal(r.v.redirected, true)
  assert.equal(r.zeroSafe, true)
  assert.equal(r.plan.action, "zero_stock")
  assert.equal(r.wouldZero, true)
  const browser = classifyVerifiedAmazonSource({
    requestedAsin: "B00TEST001",
    finalAsin: "B00OTHER99",
    displayedPrice: 9.99,
    isPrime: true,
    isFba: true,
    shipsFromAmazon: true,
    availabilityText: "In Stock",
    stockStatus: "IN_STOCK",
  })
  assert.equal(browser.outcome, "CONFIRMED_NO_VALID_SOURCE")
  assert.equal(browser.code, "SOURCE_ASIN_MISMATCH")
}

// 3. requested≠returned, final URL different → zero stock
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: wrap({
      url: "https://www.amazon.com/dp/B00OTHER99",
      asin: "B00OTHER99",
      asin_in_url: "B00OTHER99",
      title: "Redirected",
      price: 9.99,
      currency: "USD",
      stock: "In Stock",
      featured_merchant: amazonFeatured,
    }),
    panelPrice: 19.99,
    listing: listing("B00TEST001"),
    mutations: true,
  })
  assert.equal(r.v.outcome, "CONFIRMED_NO_VALID_SOURCE")
  assert.equal(r.wouldZero, true)
}

// 4. returned null → inconclusive, mutation 0
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: wrap({
      url: "https://www.amazon.com/dp/B00TEST001",
      asin: "",
      asin_in_url: "",
      title: "No asin",
      price: 19.99,
      currency: "USD",
      stock: "In Stock",
      featured_merchant: amazonFeatured,
    }),
    panelPrice: 19.99,
    listing: listing("B00TEST001"),
    mutations: true,
  })
  assert.equal(r.identity.code, "INCONCLUSIVE")
  assert.equal(r.d.audit, "PRODUCT_INCONCLUSIVE")
  assert.equal(r.v.outcome, "UNKNOWN")
  assert.equal(r.wouldZero, false)
  assert.equal(r.plan.action, "none")
}

// 5. same ASIN + explicit OOS → zero stock
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: wrap({
      url: "https://www.amazon.com/dp/B00TEST001",
      asin: "B00TEST001",
      asin_in_url: "B00TEST001",
      title: "Gone",
      price: 0,
      currency: "USD",
      stock: "Currently unavailable. We don't know when or if this item will be back in stock.",
      featured_merchant: {},
    }),
    panelPrice: 14.97,
    listing: listing("B00TEST001", { trusted: 14.97 }),
    mutations: true,
  })
  assert.equal(r.d.audit, "OUT_OF_STOCK")
  assert.equal(r.v.outcome, "CONFIRMED_NO_VALID_SOURCE")
  assert.equal(r.v.code, "OUT_OF_STOCK")
  assert.equal(r.wouldZero, true)
}

// 6. same ASIN + price increase → existing profit formula
{
  const amazonAfter = 29.99
  const percent = 15
  const r = dryRun({
    requested: "B00TEST001",
    payload: sameAsinOffer("B00TEST001", amazonAfter),
    panelPrice: 19.99,
    listing: listing("B00TEST001", { trusted: 19.99, ebayPrice: 33.31 }),
    mutations: true,
  })
  assert.equal(r.d.audit, "PRICE_CHANGE")
  assert.equal(r.v.outcome, "VALID_SOURCE")
  assert.equal(r.plan.action, "profit_protection")
  assert.equal(r.wouldPrice, true)
  const calc = calculateListingPrice({
    amazonCost: amazonAfter,
    pricingMode: "PERCENTAGE_NET_PROFIT",
    percentageNetProfitPercent: percent,
  })
  const target = amazonAfter * percent / 100
  const divisor = 1 - (1 + BUYER_TAX_RATE_ASSUMPTION) * EBAY_FINAL_VALUE_FEE_RATE
  assert.ok(Math.abs(calc.targetNetProfit - target) < 0.001)
  assert.ok(calc.calculatedListingPrice > 33.31)
  assert.equal(calc.fixedOrderFee, EBAY_FIXED_ORDER_FEE)
  assert.ok(divisor > 0)
  // recommended > current eBay → would raise; never a parallel formula
}

// 7. same ASIN + price decrease → eBay not lowered
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: sameAsinOffer("B00TEST001", 9.99),
    panelPrice: 19.99,
    listing: listing("B00TEST001", { trusted: 19.99, ebayPrice: 33.31 }),
    mutations: true,
  })
  assert.equal(r.d.audit, "PRICE_CHANGE")
  assert.equal(r.plan.action, "verified_ok")
  assert.equal(r.wouldPrice, false)
  assert.equal(r.wouldZero, false)
}

// 8. same ASIN + unknown stock → mutation 0
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: wrap({
      url: "https://www.amazon.com/dp/B00TEST001",
      asin: "B00TEST001",
      asin_in_url: "B00TEST001",
      title: "Widget",
      price: 19.99,
      currency: "USD",
      stock: "",
      featured_merchant: amazonFeatured,
      buybox: primeBuybox(19.99, ""),
    }),
    panelPrice: 19.99,
    listing: listing("B00TEST001"),
    mutations: true,
  })
  assert.equal(r.d.audit, "PRODUCT_INCONCLUSIVE")
  assert.equal(r.wouldZero, false)
}

// 9. listing not live → mutation 0
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: wrap({
      url: "https://www.amazon.com/dp/B00OTHER99",
      asin: "B00OTHER99",
      asin_in_url: "B00OTHER99",
      title: "Redirected",
      price: 9.99,
      currency: "USD",
      stock: "In Stock",
      featured_merchant: amazonFeatured,
    }),
    panelPrice: 19.99,
    listing: listing("B00TEST001", { live: false }),
    mutations: true,
  })
  assert.equal(r.guard.ok, false)
  assert.equal(r.wouldZero, false)
}

// 10. quantity already 0 → duplicate mutation 0
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: wrap({
      url: "https://www.amazon.com/dp/B00OTHER99",
      asin: "B00OTHER99",
      asin_in_url: "B00OTHER99",
      title: "Redirected",
      price: 9.99,
      currency: "USD",
      stock: "In Stock",
      featured_merchant: amazonFeatured,
    }),
    panelPrice: 19.99,
    listing: listing("B00TEST001", { qty: 0 }),
    mutations: true,
  })
  assert.equal(r.plan.action, "none")
  assert.equal(r.wouldZero, false)
}

// 11. source ASIN changed after job → mutation 0
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: wrap({
      url: "https://www.amazon.com/dp/B00OTHER99",
      asin: "B00OTHER99",
      asin_in_url: "B00OTHER99",
      title: "Redirected",
      price: 9.99,
      currency: "USD",
      stock: "In Stock",
      featured_merchant: amazonFeatured,
    }),
    panelPrice: 19.99,
    listing: listing("B00MOVED99"),
    mutations: true,
  })
  assert.equal(r.guard.ok, false)
  assert.equal(r.guard.ok === false && r.guard.code, "STALE_SOURCE_RESULT")
  assert.equal(r.wouldZero, false)
}

// 12. stale: not live + qty 0 combined obsolete
{
  const r = dryRun({
    requested: "B00TEST001",
    payload: sameAsinOffer("B00TEST001", 29.99),
    panelPrice: 19.99,
    listing: listing("B00TEST001", { live: false, qty: 0, ebayItemId: "" }),
    mutations: true,
  })
  assert.equal(r.guard.ok, false)
  assert.equal(r.wouldZero, false)
  assert.equal(r.wouldPrice, false)
}

// 13. replay: same operation keys; qty already 0 after first apply
{
  const first = dryRun({
    requested: "B00TEST001",
    payload: wrap({
      url: "https://www.amazon.com/dp/B00OTHER99",
      asin: "B00OTHER99",
      asin_in_url: "B00OTHER99",
      title: "Redirected",
      price: 9.99,
      currency: "USD",
      stock: "In Stock",
      featured_merchant: amazonFeatured,
    }),
    panelPrice: 19.99,
    listing: listing("B00TEST001"),
    mutations: true,
  })
  const replay = dryRun({
    requested: "B00TEST001",
    payload: wrap({
      url: "https://www.amazon.com/dp/B00OTHER99",
      asin: "B00OTHER99",
      asin_in_url: "B00OTHER99",
      title: "Redirected",
      price: 9.99,
      currency: "USD",
      stock: "In Stock",
      featured_merchant: amazonFeatured,
    }),
    panelPrice: 19.99,
    listing: listing("B00TEST001", { qty: 0 }),
    mutations: true,
  })
  assert.equal(first.wouldZero, true)
  assert.equal(replay.wouldZero, false)
  assert.equal(stockZeroIdempotencyKey(6142), stockZeroIdempotencyKey(6142))
  const fp = "abc"
  assert.equal(
    oxylabsOperationKey({ provider: "OXYLABS_PRODUCT", candidateId: 1821, fingerprint: fp }),
    oxylabsOperationKey({ provider: "OXYLABS_PRODUCT", candidateId: 1821, fingerprint: fp })
  )
  assert.equal(profitProtectionIdempotencyKey(1, 2999), "v2:price_protection:1:2999")
}

// 14. eBay fail does not actioned — proved by domain catch path
{
  const src = fs.readFileSync(path.join(__dirname, "../modules/stockGuard/confirmedNoValidSourcePipeline.ts"), "utf8")
  assert.match(src, /markActiveReviewFailed/)
  assert.match(src, /planAction: "zero_stock_failed"/)
  assert.match(src, /ebayMutated: false/)
  assert.doesNotMatch(src.split("catch")[1] ?? "", /ebay_quantity = 0/)
}

// 15–16 CONFIRM / Pricing 0
assert.equal(shouldEnqueueOxylabsConfirm(), false)
{
  const root = path.join(__dirname, "..")
  for (const f of [
    "modules/oxylabsVerify/oxylabsVerifyHandlers.ts",
    "modules/oxylabsVerify/oxylabsVerifyChain.ts",
    "modules/oxylabsVerify/oxylabsVerifyApply.ts",
  ]) {
    const src = fs.readFileSync(path.join(root, f), "utf8")
    assert.doesNotMatch(src, /kind:\s*OXYLABS_PRODUCT_CONFIRM/)
    assert.doesNotMatch(src, /source:\s*"amazon_pricing"/)
  }
}

const applySrc = fs.readFileSync(path.join(__dirname, "../modules/oxylabsVerify/oxylabsVerifyApply.ts"), "utf8")
assert.match(applySrc, /applyConfirmedNoValidSource/)
assert.match(applySrc, /applyAcceptedSourcePrice/)
assert.match(applySrc, /planVerifiedStockAction/)
assert.match(applySrc, /classifySourceApplyGuard/)
const handlerSrc = fs.readFileSync(path.join(__dirname, "../modules/oxylabsVerify/oxylabsVerifyHandlers.ts"), "utf8")
assert.match(handlerSrc, /applyOxylabsCompletedScanJob/)
assert.match(handlerSrc, /alreadyCompleted/)

const stored = [
  {
    id: "6936",
    requested: "B07GCJY7XG",
    panelPrice: 5.99,
    payload: wrap({
      url: "https://www.amazon.com/dp/B07GCJY7XG?lv=shuf&language=en_US&channelId=520&plpRedirect=mhFallback",
      asin: "B098MQ3FWG",
      asin_in_url: "B07GCJY7XG",
      title: "Royal Kraft Wooden Stamps DIY Fabric, Textile, Clay, Pottery, Paper, Henna Printing Blocks THDtag104",
      price: 8.99,
      currency: "USD",
      stock: "In Stock",
      featured_merchant: {
        name: "Royal Kraft",
        seller_id: "A33D419KSLD5HZ",
        shipped_from: "Royal Kraft",
        is_amazon_fulfilled: false,
      },
    }),
    expectOutcome: "CONFIRMED_NO_VALID_SOURCE",
    expectZero: true,
  },
  {
    id: "6937",
    requested: "B0881XRXKN",
    panelPrice: 10.86,
    payload: wrap({
      url: "https://www.amazon.com/dp/B0881XRXKN?language=en_US",
      asin: "B0881XKZNJ",
      asin_in_url: "B0881XRXKN",
      title: "Eastman 6 Inch Pipe Repair Clamp, 1-1/2 Inch IPS Connection, Stainless Steel, 45197",
      price: 16.42,
      currency: "USD",
      stock: "In Stock",
      featured_merchant: { name: "Amazon.com", seller_id: "", shipped_from: "Amazon.com", is_amazon_fulfilled: true },
      buybox: [{ price: 16.42, stock: "In Stock", delivery_details: [{ type: "Prime members" }] }],
    }),
    expectOutcome: "CONFIRMED_NO_VALID_SOURCE",
    expectZero: true,
  },
  {
    id: "6938",
    requested: "B08DN57GYK",
    panelPrice: 19.0,
    payload: wrap({
      url: "https://www.amazon.com/dp/B08DN57GYK?language=en_US",
      asin: "B08DN57GYK",
      asin_in_url: "B08DN57GYK",
      title: "I DEW CARE Blemish Heartleaf Skincare Set - Cleanser, Serum & Clay Mask",
      price: 19,
      currency: "USD",
      stock: "Only 3 left in stock - order soon.",
      condition: "NEW",
      featured_merchant: {
        name: "MBX Corp",
        seller_id: "A1OPF31LFC3IB3",
        shipped_from: "Amazon",
        is_amazon_fulfilled: true,
      },
      buybox: [{ price: 19, stock: "Only 3 left in stock - order soon.", delivery_details: [{ type: "Prime members" }] }],
    }),
    expectOutcome: "VALID_SOURCE",
    expectZero: false,
    expectAudit: "NO_BUSINESS_CHANGE",
  },
  {
    id: "6939",
    requested: "B08FD8P2WL",
    panelPrice: 14.97,
    payload: wrap({
      url: "https://www.amazon.com/dp/B08FD8P2WL?lv=shuf&language=en_US&channelId=500&plpRedirect=mhFallback",
      asin: "B08FD8P2WL",
      asin_in_url: "B08FD8P2WL",
      title: "NUT CRAVINGS - Dried Jumbo Medjool Dates (16oz, 1 LB) No Sugar Added",
      price: 0,
      currency: "USD",
      stock: "Currently unavailable. We don't know when or if this item will be back in stock.",
      featured_merchant: {},
    }),
    expectOutcome: "CONFIRMED_NO_VALID_SOURCE",
    expectZero: true,
    expectAuditMutOff: "WOULD_APPLY_STOCK",
  },
  {
    id: "6940",
    requested: "B08FX81Y7Y",
    panelPrice: 14.99,
    payload: wrap({
      url: "https://www.amazon.com/dp/B08FX81Y7Y?language=en_US",
      asin: "B08FWVL77G",
      asin_in_url: "B08FX81Y7Y",
      title: "Men’s Heavy Duty Belt Loops X Back 1.4 Inch Suspenders with 4 Snap Hooks",
      price: 14.99,
      currency: "USD",
      stock: "In Stock",
      featured_merchant: {
        name: "Doloise",
        seller_id: "A16QQKSUTN83M4",
        shipped_from: "Amazon",
        is_amazon_fulfilled: true,
      },
      buybox: [{ price: 14.99, stock: "In Stock", delivery_details: [{ type: "Prime members" }] }],
    }),
    expectOutcome: "CONFIRMED_NO_VALID_SOURCE",
    expectZero: true,
  },
]

const canaryReport: Array<Record<string, unknown>> = []
for (const row of stored) {
  const rOn = dryRun({
    requested: row.requested,
    payload: row.payload,
    panelPrice: row.panelPrice,
    listing: listing(row.requested, { trusted: row.panelPrice }),
    mutations: true,
  })
  const rOff = dryRun({
    requested: row.requested,
    payload: row.payload,
    panelPrice: row.panelPrice,
    listing: listing(row.requested, { trusted: row.panelPrice }),
    mutations: false,
  })
  assert.equal(rOn.v.outcome, row.expectOutcome, `job ${row.id} outcome`)
  assert.equal(rOn.wouldZero, row.expectZero, `job ${row.id} wouldZero`)
  assert.equal(rOff.wouldZero, false, `job ${row.id} mutations off`)
  if (row.expectAudit) assert.equal(rOn.d.audit, row.expectAudit)
  if (row.expectAuditMutOff) assert.equal(rOff.d.audit, row.expectAuditMutOff)
  canaryReport.push({
    id: row.id,
    outcome: rOn.v.outcome,
    code: rOn.v.code,
    auditOn: rOn.d.audit,
    auditOff: rOff.d.audit,
    wouldZeroIfMutationsOn: rOn.wouldZero,
    wouldZeroIfMutationsOff: rOff.wouldZero,
  })
}

console.log(JSON.stringify({ canaryDryRun: canaryReport }, null, 2))
console.log("PASS oxylabs apply-rules fixtures")
