// ─────────────────────────────────────────────────────────────
// publishGuardService.ts
//
// Policy değişikliği (sertleştirildi):
//   pricingSource = "fallback"  → error (BLOCK)
//   images.count = 0            → error (BLOCK)
//   images.count 1-2            → warning (pass with warn)
// ─────────────────────────────────────────────────────────────

import type { EbayListingPayload } from "../ebay/ebayPayloadService"
import type { StoreSettingsRow }   from "../storeSettings/storeSettingsTypes"
import type {
  GuardCheckResult,
  GuardInput,
  GuardResult,
} from "./publishGuardTypes"

// ─── CHECK BUILDER ────────────────────────────────────────────

function check(
  field:    string,
  passed:   boolean,
  severity: GuardCheckResult["severity"],
  message:  string
): GuardCheckResult {
  return { field, passed, severity, message }
}

// ─── TITLE ────────────────────────────────────────────────────

function checkTitle(p: EbayListingPayload): GuardCheckResult[] {
  const t = (p.title ?? "").trim()
  const amazonLeak = [/amazon/i, /amzn/i, /fulfilled by/i, /sold by amazon/i].some(rx => rx.test(t))

  return [
    check("title.empty",      t.length > 0,   "error",   t.length > 0   ? "Title is present"                          : "Title is empty"),
    check("title.minLength",  t.length >= 10,  "warning", t.length >= 10 ? `Title length OK (${t.length} chars)`       : `Title too short (${t.length} chars, min 10)`),
    check("title.maxLength",  t.length <= 80,  "warning", t.length <= 80 ? `Title within eBay limit (${t.length}/80)`  : `Title exceeds 80 chars (${t.length})`),
    check("title.amazonLeak", !amazonLeak,     "error",   !amazonLeak    ? "Title is clean of Amazon references"        : "Title contains Amazon reference"),
  ]
}

// ─── PRICE ────────────────────────────────────────────────────

function checkPrice(p: EbayListingPayload): GuardCheckResult[] {
  return [
    check("price.valid",
      p.price > 0, "error",
      p.price > 0 ? `Price is valid ($${p.price.toFixed(2)})` : `Price is zero or negative ($${p.price})`
    ),
    check("price.aboveCost",
      p.price >= p.amazonCost, "error",
      p.price >= p.amazonCost
        ? `Price ($${p.price.toFixed(2)}) is above cost ($${p.amazonCost.toFixed(2)})`
        : `Price ($${p.price.toFixed(2)}) is below Amazon cost ($${p.amazonCost.toFixed(2)})`
    ),
    check("price.amazonCostValid",
      p.amazonCost > 0, "warning",
      p.amazonCost > 0 ? `Amazon cost present ($${p.amazonCost.toFixed(2)})` : "Amazon cost is zero or missing"
    ),
    // ── HARDENED: fallback pricing → BLOCK ────────────────────
    check("price.pricingSource",
      p.pricingSource === "calculated", "error",
      p.pricingSource === "calculated"
        ? "Price was calculated from store settings"
        : "BLOCK: fallback pricing — store settings missing or disabled, or amazon cost not available"
    ),
    check("price.maxSanity",
      p.price <= 10000, "warning",
      p.price <= 10000 ? "Price within sanity range" : `Price unusually high ($${p.price.toFixed(2)})`
    ),
  ]
}

// ─── DESCRIPTION ──────────────────────────────────────────────

function checkDescription(p: EbayListingPayload): GuardCheckResult[] {
  const d = (p.description ?? "").trim()
  const amazonLeak = [/amazon\.com/i, /amzn\.to/i, /fulfilled by amazon/i].some(rx => rx.test(d))

  return [
    check("description.empty",      d.length > 0,   "error",   d.length > 0   ? "Description is present"               : "Description is empty"),
    check("description.minLength",  d.length >= 50,  "warning", d.length >= 50 ? `Description length OK (${d.length} chars)` : `Description too short (${d.length} chars, min 50)`),
    check("description.amazonLeak", !amazonLeak,     "error",   !amazonLeak    ? "Description is clean"                 : "Description contains Amazon URL or reference"),
  ]
}

// ─── IMAGES ───────────────────────────────────────────────────

function checkImages(p: EbayListingPayload): GuardCheckResult[] {
  const n = p.images.length
  return [
    // ── HARDENED: 0 images → BLOCK ────────────────────────────
    check("images.count",
      n >= 1, "error",
      n >= 1 ? `${n} image(s) present` : "BLOCK: no images — eBay listing requires at least 1 photo"
    ),
    // 1-2 images → WARNING (still publishable)
    check("images.recommended",
      n >= 3, "warning",
      n >= 3 ? `${n} images (recommended: 3+)` : `Only ${n} image(s) (recommended: 3+)`
    ),
  ]
}

// ─── ITEM ─────────────────────────────────────────────────────

function checkItem(p: EbayListingPayload): GuardCheckResult[] {
  return [
    check("item.quantity",  Number.isInteger(p.quantity) && p.quantity >= 1, "error",   p.quantity >= 1     ? `Quantity OK (${p.quantity})`     : `Invalid quantity (${p.quantity})`),
    check("item.condition", p.condition === "NEW",                            "warning", p.condition === "NEW" ? "Condition is NEW"               : `Unexpected condition: ${p.condition}`),
    check("item.sku",       (p.sku ?? "").length > 0,                        "error",   (p.sku ?? "").length > 0 ? `SKU present (${p.sku})`      : "SKU is empty"),
  ]
}

// ─── POLICIES ─────────────────────────────────────────────────

function checkPolicies(settings: StoreSettingsRow | null): GuardCheckResult[] {
  const hasMerchant    = !!settings?.merchantLocationKey?.trim()
  const hasPayment     = !!settings?.paymentPolicyId?.trim()
  const hasReturn      = !!settings?.returnPolicyId?.trim()
  const hasFulfillment = !!settings?.fulfillmentPolicyId?.trim()

  return [
    check("policies.merchantLocation", hasMerchant,    "error", hasMerchant    ? `merchantLocationKey: ${settings!.merchantLocationKey}` : "merchantLocationKey is missing — required for eBay publish"),
    check("policies.payment",          hasPayment,      "error", hasPayment     ? `paymentPolicyId: ${settings!.paymentPolicyId}`         : "paymentPolicyId is missing — required for eBay publish"),
    check("policies.return",           hasReturn,       "error", hasReturn      ? `returnPolicyId: ${settings!.returnPolicyId}`           : "returnPolicyId is missing — required for eBay publish"),
    check("policies.fulfillment",      hasFulfillment,  "error", hasFulfillment ? `fulfillmentPolicyId: ${settings!.fulfillmentPolicyId}` : "fulfillmentPolicyId is missing — required for eBay publish"),
    ...(settings
      ? [check("policies.settingsEnabled", settings.enabled === true, "error", settings.enabled ? "Store settings are enabled" : "Store settings are disabled")]
      : [check("policies.settingsExists", false, "error", "No store_settings row found — policies cannot be validated")]
    ),
  ]
}

// ─── EXTRA ────────────────────────────────────────────────────

function checkExtra(extra: GuardInput["extra"]): GuardCheckResult[] {
  if (!extra) return []
  const results: GuardCheckResult[] = []
  if (extra.isDuplicate     !== undefined) results.push(check("extra.duplicate",       !extra.isDuplicate,     "error",   extra.isDuplicate     ? "ASIN is already listed in this store — duplicate"  : "No duplicate detected"))
  if (extra.isBlacklisted   !== undefined) results.push(check("extra.blacklisted",     !extra.isBlacklisted,   "error",   extra.isBlacklisted   ? "ASIN or brand is blacklisted"                      : "Not blacklisted"))
  if (extra.existsInCatalog !== undefined) results.push(check("extra.existsInCatalog", !extra.existsInCatalog, "warning", extra.existsInCatalog ? "Already exists in store_catalog_state"             : "Not in store catalog"))
  return results
}

// ─── SCORE ────────────────────────────────────────────────────

function computeScore(checks: GuardCheckResult[]): number {
  const errorCount = checks.filter(c => !c.passed && c.severity === "error").length
  const warnCount  = checks.filter(c => !c.passed && c.severity === "warning").length
  return Math.max(0, Math.min(100, 100 - (errorCount * 15) - (warnCount * 5)))
}

// ─── ANA FONKSİYON ────────────────────────────────────────────

export function runPublishGuard(input: GuardInput): GuardResult {
  const { payload, storeSettings, extra } = input

  const checks: GuardCheckResult[] = [
    ...checkTitle(payload),
    ...checkPrice(payload),
    ...checkDescription(payload),
    ...checkImages(payload),
    ...checkItem(payload),
    ...checkPolicies(storeSettings),
    ...checkExtra(extra),
  ]

  const errors   = checks.filter(c => !c.passed && c.severity === "error").map(c => c.message)
  const warnings = checks.filter(c => !c.passed && c.severity === "warning").map(c => c.message)
  const score    = computeScore(checks)

  return {
    poolId:        payload.poolId,
    asin:          payload.asin,
    sku:           payload.sku,
    isPublishable: errors.length === 0,
    score,
    errors,
    warnings,
    checks,
  }
}

// ─── BATCH ────────────────────────────────────────────────────

export function runPublishGuardBatch(
  payloads:      EbayListingPayload[],
  storeSettings: StoreSettingsRow | null
): GuardResult[] {
  return payloads.map(payload =>
    runPublishGuard({ payload, storeSettings })
  )
}
