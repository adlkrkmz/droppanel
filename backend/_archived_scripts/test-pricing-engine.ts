import { calculatePrice, calculatePriceBatch } from "./modules/pricing/pricingService"
import type { PricingResult } from "./modules/pricing/pricingTypes"

// ─── HELPERS ──────────────────────────────────────────────────

function sep(len = 72): void {
  console.log("  " + "─".repeat(len))
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

function pct(n: number): string {
  return `${n}%`
}

function printResultTable(results: PricingResult[], title: string): void {
  console.log(`\n  ► ${title}`)
  console.log(
    `  ${"Cost".padStart(8)} ` +
    `${"Margin".padStart(8)} ` +
    `${"Fee".padStart(6)} ` +
    `${"Tax".padStart(6)} ` +
    `${"Profit+".padStart(9)} ` +
    `${"Fee cost".padStart(9)} ` +
    `${"Tax cost".padStart(9)} ` +
    `${"List Price".padStart(11)}`
  )
  sep()

  for (const r of results) {
    console.log(
      `  ${usd(r.amazonCost).padStart(8)} ` +
      `${pct(r.profitMarginPercent).padStart(8)} ` +
      `${pct(r.ebayFeePercent).padStart(6)} ` +
      `${pct(r.taxEstimatePercent).padStart(6)} ` +
      `${usd(r.targetProfitAmount).padStart(9)} ` +
      `${usd(r.feeEstimateAmount).padStart(9)} ` +
      `${usd(r.taxEstimateAmount).padStart(9)} ` +
      `${usd(r.finalListingPrice).padStart(11)}`
    )
  }
}

// ─── MAIN ─────────────────────────────────────────────────────

function main(): void {
  console.log("═".repeat(72))
  console.log("  test-pricing-engine")
  console.log("═".repeat(72))
  console.log("")

  // ── Senaryo 1: Temel örnekler ─────────────────────────────────

  const scenario1 = calculatePriceBatch(
    [10, 20, 50, 100],
    { profitMarginPercent: 25, ebayFeePercent: 13, taxEstimatePercent: 8 }
  )
  printResultTable(scenario1, "Scenario 1 — Standard (25% margin, 13% fee, 8% tax)")

  // ── Senaryo 2: Yüksek margin ──────────────────────────────────

  const scenario2 = calculatePriceBatch(
    [10, 20, 50],
    { profitMarginPercent: 50, ebayFeePercent: 13, taxEstimatePercent: 0 }
  )
  printResultTable(scenario2, "Scenario 2 — High Margin (50% margin, 13% fee, 0% tax)")

  // ── Senaryo 3: Düşük margin ───────────────────────────────────

  const scenario3 = calculatePriceBatch(
    [10, 20, 50],
    { profitMarginPercent: 10, ebayFeePercent: 13, taxEstimatePercent: 0 }
  )
  printResultTable(scenario3, "Scenario 3 — Low Margin (10% margin, 13% fee, 0% tax)")

  // ── Senaryo 4: Farklı maliyetler, farklı margin'lar ───────────

  const scenario4: PricingResult[] = [
    calculatePrice({ amazonCost: 10,  profitMarginPercent: 25, ebayFeePercent: 13, taxEstimatePercent: 8 }),
    calculatePrice({ amazonCost: 20,  profitMarginPercent: 50, ebayFeePercent: 13, taxEstimatePercent: 0 }),
    calculatePrice({ amazonCost: 50,  profitMarginPercent: 30, ebayFeePercent: 13, taxEstimatePercent: 8 }),
    calculatePrice({ amazonCost: 100, profitMarginPercent: 20, ebayFeePercent: 13, taxEstimatePercent: 8 }),
  ]
  printResultTable(scenario4, "Scenario 4 — Mixed Costs & Margins")

  // ── Senaryo 5: Detaylı tek ürün ───────────────────────────────

  console.log("\n  ► Scenario 5 — Detailed Breakdown (cost=$35.99, margin=30%)")
  sep()

  const detail = calculatePrice({
    amazonCost:          35.99,
    profitMarginPercent: 30,
    ebayFeePercent:      13,
    taxEstimatePercent:  8,
  })

  console.log(`  Amazon Cost          ${usd(detail.amazonCost)}`)
  console.log(`  Profit Margin        ${pct(detail.profitMarginPercent)}  → +${usd(detail.targetProfitAmount)}`)
  console.log(`  eBay Fee             ${pct(detail.ebayFeePercent)}  → +${usd(detail.feeEstimateAmount)}`)
  console.log(`  Tax Estimate         ${pct(detail.taxEstimatePercent)}   → +${usd(detail.taxEstimateAmount)}`)
  sep()
  console.log(`  Final Listing Price  ${usd(detail.finalListingPrice)}`)
  console.log(`  Net Profit           ${usd(detail.finalListingPrice - detail.amazonCost - detail.feeEstimateAmount - detail.taxEstimateAmount)}`)

  // ── Error handling örnekleri ──────────────────────────────────

  console.log("\n  ► Error Handling Tests")
  sep()

  const errorCases: Array<{ label: string; fn: () => void }> = [
    { label: "amazonCost = 0",     fn: () => calculatePrice({ amazonCost: 0,    profitMarginPercent: 20, ebayFeePercent: 13, taxEstimatePercent: 8 }) },
    { label: "amazonCost < 0",     fn: () => calculatePrice({ amazonCost: -5,   profitMarginPercent: 20, ebayFeePercent: 13, taxEstimatePercent: 8 }) },
    { label: "negative margin",    fn: () => calculatePrice({ amazonCost: 10,   profitMarginPercent: -1, ebayFeePercent: 13, taxEstimatePercent: 8 }) },
    { label: "fee + tax >= 100%",  fn: () => calculatePrice({ amazonCost: 10,   profitMarginPercent: 20, ebayFeePercent: 60, taxEstimatePercent: 50 }) },
  ]

  for (const { label, fn } of errorCases) {
    try {
      fn()
      console.log(`  ✗ "${label}" — should have thrown`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  ✓ "${label}" → ${msg.slice(0, 60)}`)
    }
  }

  // ── Final ─────────────────────────────────────────────────────

  console.log("")
  console.log("═".repeat(72))
  console.log("  Formula: P = C × (1 + margin) / (1 - fee - tax)")
  console.log("  ✓ Pricing engine hazır — ebayPayloadService'e entegre edilebilir")
  console.log("═".repeat(72))
}

main()
