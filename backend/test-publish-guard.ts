import { runPublishGuard }        from "./modules/publishGuard/publishGuardService"
import type { GuardInput }         from "./modules/publishGuard/publishGuardTypes"
import type { EbayListingPayload } from "./modules/ebay/ebayPayloadService"
import type { StoreSettingsRow }   from "./modules/storeSettings/storeSettingsTypes"

// ─── SAMPLE STORE SETTINGS ────────────────────────────────────

const FULL_SETTINGS: StoreSettingsRow = {
  id:                  1,
  workspaceId:         "00000000-0000-0000-0000-000000000001",
  storeId:             1,
  profitMarginPercent: 25,
  taxEstimatePercent:  8,
  ebayFeePercent:      13,
  defaultQuantity:     1,
  templateId:          "1",
  merchantLocationKey: "warehouse-us-east",
  paymentPolicyId:     "PAY_POL_001",
  returnPolicyId:      "RET_POL_001",
  fulfillmentPolicyId: "FUL_POL_001",
  intervalMinutes:     30,
  enabled:             true,
  createdAt:           "2025-01-01T00:00:00Z",
  updatedAt:           "2025-01-01T00:00:00Z",
}

const MISSING_POLICIES: StoreSettingsRow = {
  ...FULL_SETTINGS,
  merchantLocationKey: null,
  paymentPolicyId:     null,
  returnPolicyId:      null,
  fulfillmentPolicyId: null,
}

// ─── BASE PAYLOAD ─────────────────────────────────────────────

function makePayload(overrides: Partial<EbayListingPayload>): EbayListingPayload {
  return {
    workspaceId:       "00000000-0000-0000-0000-000000000001",
    storeId:           1,
    poolId:            1,
    asinRegistryId:    1,
    asin:              "B0TEST00001",
    assignedStoreId:   1,
    storeCode:         "S1",
    storeName:         "Store Alpha",
    sku:               "DP-B0TEST00001-S1",
    title:             "Premium Wireless Headphones with Noise Cancellation",
    description:       "<div>Great headphones with active noise cancellation, 40h battery, comfortable fit for all day use.</div>",
    brand:             "SoundPro",
    price:             49.99,
    amazonCost:        29.99,
    pricingSource:     "calculated",
    templateId:        "minimal_clean",
    descriptionLength: 120,
    images:            [
      "https://example.com/img1.jpg",
      "https://example.com/img2.jpg",
      "https://example.com/img3.jpg",
    ],
    quantity:          1,
    condition:         "NEW",
    itemSpecifics:     { Brand: "SoundPro", Condition: "New", Type: "Does not apply", MPN: "Does not apply" },
    ...overrides,
  }
}

// ─── TEST CASES ───────────────────────────────────────────────
// expectOk = true  → isPublishable should be true
// expectOk = false → isPublishable should be false (blocked)

type TestCase = { label: string; input: GuardInput; expectOk: boolean }

const TEST_CASES: TestCase[] = [
  // ── Geçen ─────────────────────────────────────────────────
  {
    label: "✓ Perfect payload — all pass",
    expectOk: true,
    input: { payload: makePayload({}), storeSettings: FULL_SETTINGS },
  },
  {
    label: "~ 1-2 images — warning only (still publishable)",
    expectOk: true,
    input: { payload: makePayload({ images: ["https://example.com/img1.jpg"] }), storeSettings: FULL_SETTINGS },
  },
  {
    label: "~ Fallback cost warning (not pricing source)",
    expectOk: true,
    input: { payload: makePayload({ amazonCost: 0 }), storeSettings: FULL_SETTINGS },
  },

  // ── Blokla ────────────────────────────────────────────────
  {
    label: "✗ BLOCK: fallback pricing (HARDENED)",
    expectOk: false,
    input: { payload: makePayload({ pricingSource: "fallback" }), storeSettings: FULL_SETTINGS },
  },
  {
    label: "✗ BLOCK: 0 images (HARDENED)",
    expectOk: false,
    input: { payload: makePayload({ images: [] }), storeSettings: FULL_SETTINGS },
  },
  {
    label: "✗ BLOCK: empty title",
    expectOk: false,
    input: { payload: makePayload({ title: "" }), storeSettings: FULL_SETTINGS },
  },
  {
    label: "✗ BLOCK: Amazon leak in title",
    expectOk: false,
    input: { payload: makePayload({ title: "Best Headphones on Amazon.com" }), storeSettings: FULL_SETTINGS },
  },
  {
    label: "✗ BLOCK: price below cost",
    expectOk: false,
    input: { payload: makePayload({ price: 19.99, amazonCost: 29.99 }), storeSettings: FULL_SETTINGS },
  },
  {
    label: "✗ BLOCK: zero price",
    expectOk: false,
    input: { payload: makePayload({ price: 0 }), storeSettings: FULL_SETTINGS },
  },
  {
    label: "✗ BLOCK: empty description",
    expectOk: false,
    input: { payload: makePayload({ description: "" }), storeSettings: FULL_SETTINGS },
  },
  {
    label: "✗ BLOCK: missing policies",
    expectOk: false,
    input: { payload: makePayload({}), storeSettings: MISSING_POLICIES },
  },
  {
    label: "✗ BLOCK: no store settings",
    expectOk: false,
    input: { payload: makePayload({}), storeSettings: null },
  },
  {
    label: "✗ BLOCK: duplicate ASIN",
    expectOk: false,
    input: { payload: makePayload({}), storeSettings: FULL_SETTINGS, extra: { isDuplicate: true } },
  },
  {
    label: "✗ BLOCK: blacklisted",
    expectOk: false,
    input: { payload: makePayload({}), storeSettings: FULL_SETTINGS, extra: { isBlacklisted: true } },
  },
  {
    label: "✗ BLOCK: fallback + 0 images + missing policies",
    expectOk: false,
    input: {
      payload:       makePayload({ pricingSource: "fallback", images: [] }),
      storeSettings: MISSING_POLICIES,
    },
  },
]

// ─── HELPERS ──────────────────────────────────────────────────

function sep(len = 74): void { console.log("  " + "─".repeat(len)) }

// ─── MAIN ─────────────────────────────────────────────────────

function main(): void {
  console.log("═".repeat(74))
  console.log("  test-publish-guard  (hardened policy)")
  console.log("═".repeat(74))
  console.log("")
  console.log("  HARDENED RULES:")
  console.log("    pricingSource = 'fallback'  → BLOCK (was: warning)")
  console.log("    images.count = 0            → BLOCK (was: warning)")
  console.log("    images.count 1-2            → warning (unchanged)")
  console.log("")

  const results = TEST_CASES.map(tc => ({ ...tc, result: runPublishGuard(tc.input) }))

  // ── Summary table ─────────────────────────────────────────────
  console.log("  ► Results")
  console.log(
    `  ${"".padEnd(4)}` +
    `${"Guard".padEnd(8)}` +
    `${"Expect".padEnd(8)}` +
    `${"Score".padEnd(7)}` +
    `${"Err".padEnd(5)}` +
    `${"Warn".padEnd(6)}` +
    `Label`
  )
  sep()

  let passed = 0
  let failed = 0

  for (const tc of results) {
    const guardIcon = tc.result.isPublishable ? "✓ OK " : "⊘ BLK"
    const expectStr = tc.expectOk             ? "ok"    : "block"
    const testOk    = tc.result.isPublishable === tc.expectOk
    if (testOk) passed++; else failed++

    console.log(
      `  ${(testOk ? "✓" : "!").padEnd(4)}` +
      `${guardIcon.padEnd(8)}` +
      `${expectStr.padEnd(8)}` +
      `${String(tc.result.score).padEnd(7)}` +
      `${String(tc.result.errors.length || "").padEnd(5)}` +
      `${String(tc.result.warnings.length || "").padEnd(6)}` +
      `${tc.label}`
    )
  }

  sep()
  console.log(`  Tests: ${results.length}  passed: ${passed}  unexpected: ${failed}`)

  // ── Hardened checks detail ────────────────────────────────────
  const hardenedCases = results.filter(r =>
    r.label.includes("HARDENED") || r.label.includes("fallback") || r.label.includes("0 images")
  )
  if (hardenedCases.length > 0) {
    console.log("")
    console.log("  ► Hardened Policy Checks")
    sep(50)
    for (const tc of hardenedCases) {
      const icon = tc.result.isPublishable ? "✓ PASS" : "⊘ BLOCK"
      console.log(`  ${icon}  score=${tc.result.score}  ${tc.label}`)
      tc.result.errors.forEach(e   => console.log(`    ✗ ${e}`))
      tc.result.warnings.forEach(w => console.log(`    ⚠ ${w}`))
    }
  }

  // ── Score distribution ────────────────────────────────────────
  console.log("")
  console.log("  ► Score Distribution")
  sep(52)
  for (const tc of results) {
    const bar = "█".repeat(Math.round(tc.result.score / 5))
    const pad = "░".repeat(20 - Math.round(tc.result.score / 5))
    console.log(
      `  ${String(tc.result.score).padStart(3)} ${bar}${pad}  ` +
      `${tc.result.isPublishable ? "PUBLISH" : "BLOCK  "}  ` +
      `${tc.label.slice(0, 34)}`
    )
  }

  // ── Final ─────────────────────────────────────────────────────
  console.log("")
  console.log("═".repeat(74))
  console.log(`  Total: ${results.length}  passed: ${passed}  unexpected: ${failed}`)
  console.log(`  Publishable: ${results.filter(r => r.result.isPublishable).length}  Blocked: ${results.filter(r => !r.result.isPublishable).length}`)
  console.log("═".repeat(74))
}

main()
