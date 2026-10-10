import assert from "assert"
import fs from "fs"
import path from "path"
import { keepaSnapshotTrigger } from "../modules/keepaSensor/keepaSnapshotDiff"
import {
  classifyOxylabsPrice,
  classifyOxylabsPrimeEvidence,
  normalizeOxylabsAmazonProduct,
} from "../modules/oxylabsVerify/oxylabsProductNormalize"
import {
  decideOxylabsSingleQuery,
  shouldEnqueueOxylabsConfirm,
} from "../modules/oxylabsVerify/oxylabsProductDecision"
import { evaluateOxylabsVerifyRouteAuth } from "../modules/oxylabsVerify/oxylabsVerifyAuth"
import { loadOxylabsVerifyConfig } from "../modules/oxylabsVerify/oxylabsVerifyConfig"
import { resolveOxylabsVerifyClaimKind } from "../modules/oxylabsVerify/oxylabsVerifyKinds"
import { oxylabsFeederRemaining } from "../modules/oxylabsVerify/oxylabsVerifyQueueCap"
import { planVerifiedStockAction } from "../modules/stockGuard/verifiedStockActionPlan"
import { mapOxylabsToVerifiedDecision } from "../modules/oxylabsVerify/oxylabsProductDecision"
import { isInternalScraperApiPath } from "../modules/security/httpSecurity"

function wrap(content: Record<string, unknown>, status = 200): Record<string, unknown> {
  return { results: [{ content, status_code: status, parse_status_code: 12000 }] }
}

const baseOffer = {
  url: "https://www.amazon.com/dp/B00TEST001",
  asin: "B00TEST001",
  asin_in_url: "B00TEST001",
  title: "Widget",
  price: 19.99,
  currency: "USD",
  stock: "In Stock",
  condition: "NEW",
  featured_merchant: {
    name: "Amazon.com",
    seller_id: "ATVPDKIKX0DER",
    is_amazon_fulfilled: true,
    is_prime_eligible: true,
    shipped_from: "Amazon.com",
  },
}

const snap = {
  amazonCents: 1000,
  newCents: 1100,
  buyBoxCents: 1000,
  primeExclusiveCents: null as number | null,
  availability: "IN_STOCK",
  buyBoxIsPrimeExclusive: true as boolean | null,
  newFbaCount: 3,
  newFbmCount: 1,
}

assert.equal(keepaSnapshotTrigger(null, snap), "baseline")
assert.equal(keepaSnapshotTrigger(snap, snap), "unchanged")
assert.equal(keepaSnapshotTrigger(snap, { ...snap, amazonCents: 1200 }), "changed")
assert.equal(keepaSnapshotTrigger(snap, snap), "unchanged")
assert.equal(keepaSnapshotTrigger(snap, snap), "unchanged")

{
  const n = normalizeOxylabsAmazonProduct({ requestedAsin: "B00TEST001", payload: wrap(baseOffer) })
  assert.equal(n.primeEvidence, "EXPLICIT_TRUE")
}
{
  const n = normalizeOxylabsAmazonProduct({
    requestedAsin: "B00TEST001",
    payload: wrap({
      ...baseOffer,
      featured_merchant: { ...baseOffer.featured_merchant, is_prime_eligible: false },
      buybox: [{ delivery_details: [{ type: "Prime members" }] }],
    }),
  })
  assert.equal(n.primeEvidence, "EXPLICIT_FALSE")
}
{
  const n = normalizeOxylabsAmazonProduct({
    requestedAsin: "B00TEST001",
    payload: wrap({
      ...baseOffer,
      featured_merchant: { ...baseOffer.featured_merchant, is_prime_eligible: undefined },
      buybox: [{ delivery_details: [{ type: "Prime members" }] }],
    }),
  })
  assert.equal(classifyOxylabsPrimeEvidence({ explicitPrime: null, designatedDeliveryTypes: ["Prime members"] }), "DELIVERY_PRIME")
  assert.equal(n.primeEvidence, "DELIVERY_PRIME")
}
{
  const n = normalizeOxylabsAmazonProduct({
    requestedAsin: "B00TEST001",
    payload: wrap({
      ...baseOffer,
      title: "Prime branded gadget",
      featured_merchant: { ...baseOffer.featured_merchant, is_prime_eligible: undefined },
    }),
  })
  assert.equal(n.primeEvidence, "UNKNOWN")
}

function decide(payload: Record<string, unknown>, panelPrice: number | null, mutations = false, requested = "B00TEST001") {
  const n = normalizeOxylabsAmazonProduct({ requestedAsin: requested, payload })
  return {
    n,
    d: decideOxylabsSingleQuery({
      n,
      panel: { sourceAsin: requested, sourcePrice: panelPrice, listingLive: true, qty: 2 },
      mutationsEnabled: mutations,
    }),
  }
}

{
  const { d } = decide(wrap(baseOffer), 19.99)
  assert.equal(d.audit, "NO_BUSINESS_CHANGE")
  assert.equal(d.enqueueConfirm, false)
  assert.equal(d.applyMutation, false)
}
{
  const { d } = decide(wrap({ ...baseOffer, price: 29.99 }), 19.99, false)
  assert.equal(d.audit, "WOULD_APPLY_PRICE")
  assert.equal(d.applyMutation, false)
}
{
  const { d } = decide(wrap({ ...baseOffer, price: 29.99 }), 19.99, true)
  assert.equal(d.audit, "PRICE_CHANGE")
  assert.equal(d.applyMutation, true)
}
{
  const { n, d } = decide(wrap({ ...baseOffer, price: 9.99 }), 19.99, true)
  const decision = mapOxylabsToVerifiedDecision({ n, productClass: d.productClass, code: d.evidenceCode })
  const plan = planVerifiedStockAction({
    decision,
    settings: { enabled: true, mode: "auto", priceAlertEnabled: true, autoProfitProtectionEnabled: true },
    currentEbayQuantity: 2,
    trustedBaselinePrice: 19.99,
    lastVerifiedDecision: "VALID_SOURCE",
    verifiedActionsEnabled: true,
    lastVerifiedAsin: "B00TEST001",
    currentSourceAsin: "B00TEST001",
  })
  assert.equal(plan.action, "verified_ok")
}
{
  const { d } = decide(
    wrap({
      ...baseOffer,
      price: 0,
      stock: "Currently unavailable.",
      featured_merchant: {},
    }),
    19.99,
    false
  )
  assert.equal(d.audit, "WOULD_APPLY_STOCK")
  assert.equal(d.applyMutation, false)
}
{
  const { d } = decide(wrap({ ...baseOffer, price: 0, stock: "" }), 19.99)
  assert.equal(d.audit, "PRODUCT_INCONCLUSIVE")
}
{
  const { d } = decide(
    wrap({
      ...baseOffer,
      featured_merchant: { name: "X", seller_id: "A1", is_amazon_fulfilled: true, shipped_from: "Amazon" },
    }),
    19.99
  )
  assert.equal(d.audit, "PRODUCT_INCONCLUSIVE")
}
{
  const { d } = decide(
    wrap({
      ...baseOffer,
      featured_merchant: {
        name: "X",
        seller_id: "A1",
        is_amazon_fulfilled: false,
        is_prime_eligible: true,
        shipped_from: "Amazon",
      },
    }),
    19.99
  )
  assert.equal(d.audit, "PRODUCT_INCONCLUSIVE")
}
{
  const { d } = decide(
    wrap({
      url: "https://www.amazon.com/dp/B00OTHER99",
      asin: "B00OTHER99",
      asin_in_url: "B00OTHER99",
      title: "Redirected",
      price: 9.99,
      currency: "USD",
      stock: "In Stock",
      featured_merchant: baseOffer.featured_merchant,
    }),
    9.99,
    false,
    "B00TEST001"
  )
  assert.equal(d.audit, "ASIN_IDENTITY_CHANGED")
}
{
  const { d } = decide(
    wrap({
      url: "https://www.amazon.com/dp/B00TEST001",
      asin: "B00OTHER99",
      asin_in_url: "B00TEST001",
      title: "Variant",
      price: 9.99,
      currency: "USD",
      stock: "In Stock",
      featured_merchant: baseOffer.featured_merchant,
    }),
    9.99,
    false,
    "B00TEST001"
  )
  assert.equal(d.audit, "ASIN_IDENTITY_CHANGED")
}

assert.equal(shouldEnqueueOxylabsConfirm(), false)
assert.equal(resolveOxylabsVerifyClaimKind("oxylabs-product-primary-A"), "OXYLABS_PRODUCT_PRIMARY")
assert.equal(resolveOxylabsVerifyClaimKind("oxylabs-product-confirm-C"), null)

{
  const rem = oxylabsFeederRemaining({
    canaryMax: 10,
    uniqueReservationCount: 5,
    unreservedActiveOxylabsJobCount: 0,
  })
  assert.equal(rem, 5)
}

assert.equal(classifyOxylabsPrice(-1).kind, "SENTINEL_NEG1")
assert.equal(classifyOxylabsPrice(-2).kind, "SENTINEL_NEG2")
assert.equal(classifyOxylabsPrice(0).kind, "ZERO")
assert.equal(classifyOxylabsPrice(null).kind, "NULL")
assert.equal(classifyOxylabsPrice("").kind, "EMPTY")

{
  const cookieOff = evaluateOxylabsVerifyRouteAuth({
    protocolEnabled: false,
    tokenConfigured: true,
    tokenOk: true,
    foreignToken: false,
    hasSessionCookie: true,
  })
  assert.equal("ok" in cookieOff, false)
}

process.env.OXYLABS_VERIFY_MUTATIONS_ENABLED = "false"
assert.equal(loadOxylabsVerifyConfig().mutationsEnabled, false)

const root = path.join(__dirname, "..")
for (const f of [
  "modules/oxylabsVerify/oxylabsVerifyHandlers.ts",
  "modules/oxylabsVerify/oxylabsVerifyChain.ts",
  "modules/oxylabsVerify/oxylabsVerifyApply.ts",
]) {
  const src = fs.readFileSync(path.join(root, f), "utf8")
  assert.doesNotMatch(src, /maybeEnqueueOxylabsProductConfirm/)
  assert.doesNotMatch(src, /kind:\s*OXYLABS_PRODUCT_CONFIRM/)
  assert.doesNotMatch(src, /source:\s*"amazon_pricing"/)
}
assert.doesNotMatch(
  fs.readFileSync(path.join(root, "modules/oxylabsVerify/oxylabsVerifyChain.ts"), "utf8"),
  /enqueueOxylabsScanJob\(\{[\s\S]*kind:\s*OXYLABS_PRODUCT_CONFIRM/
)
assert.equal(isInternalScraperApiPath("/internal/oxylabs-verify/claim-next"), true)
const worker = fs.readFileSync(path.join(root, "deploy/oxylabs-worker/oxylabs-verify-worker.mjs"), "utf8")
assert.match(worker, /1\.0\.2/)
assert.doesNotMatch(worker, /applyAcceptedSourcePrice/)

console.log("PASS oxylabs single-query fixtures")
