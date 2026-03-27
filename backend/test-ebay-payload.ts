import "dotenv/config"
import { closeDbPool }              from "./db/client"
import { buildEbayListingPayloads } from "./modules/ebay/ebayPayloadService"
import type { EbayListingPayload }  from "./modules/ebay/ebayPayloadService"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) throw new Error("WORKSPACE_ID is not defined in .env")
const WORKSPACE_ID: string = workspaceId

const LIMIT = parseInt(process.env.PAYLOAD_LIMIT ?? "20", 10)

// ─── HELPERS ──────────────────────────────────────────────────

function sep(len = 84): void {
  console.log("  " + "─".repeat(len))
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

function priceIcon(src: EbayListingPayload["pricingSource"]): string {
  return src === "calculated" ? "✓" : "~"
}

// ─── MAIN ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(84))
  console.log("  test-ebay-payload")
  console.log("═".repeat(84))
  console.log(`  workspace : ${WORKSPACE_ID}`)
  console.log(`  limit     : ${LIMIT}`)
  console.log("")

  const payloads = await buildEbayListingPayloads(WORKSPACE_ID, LIMIT)

  if (payloads.length === 0) {
    console.log("  Payload bulunamadı.")
    console.log("  Kontrol et:")
    console.log("    asin_pool.status         = 'ready'")
    console.log("    asin_pool.pipeline_stage = 'ai_generated'")
    console.log("    asin_pool.assigned_store_id IS NOT NULL")
    console.log("    stores.status            = 'active'")
    return
  }

  // ── Ana tablo ─────────────────────────────────────────────────

  console.log(`  ► Payload Table (${payloads.length} rows)`)
  console.log("")
  console.log(
    `  ${"".padEnd(3)}` +
    `${"ASIN".padEnd(14)}` +
    `${"Store".padEnd(8)}` +
    `${"Cost".padEnd(9)}` +
    `${"Price".padEnd(9)}` +
    `${"Pricing".padEnd(12)}` +
    `${"TplID".padEnd(16)}` +
    `${"DescLen".padEnd(9)}` +
    `SKU`
  )
  sep()

  for (const p of payloads) {
    const upliftPct = p.amazonCost > 0
      ? `+${((p.price - p.amazonCost) / p.amazonCost * 100).toFixed(0)}%`
      : "n/a"

    console.log(
      `  ${priceIcon(p.pricingSource).padEnd(3)}` +
      `${p.asin.padEnd(14)}` +
      `${p.storeCode.padEnd(8)}` +
      `${usd(p.amazonCost).padEnd(9)}` +
      `${(usd(p.price) + ` (${upliftPct})`).padEnd(9+8)}` +
      `${p.pricingSource.padEnd(12)}` +
      `${p.templateId.padEnd(16)}` +
      `${String(p.descriptionLength).padEnd(9)}` +
      `${p.sku}`
    )
  }

  sep()

  // ── Stats ─────────────────────────────────────────────────────

  const calc    = payloads.filter(p => p.pricingSource === "calculated")
  const fallb   = payloads.filter(p => p.pricingSource === "fallback")
  const tplCounts: Record<string, number> = {}
  for (const p of payloads) {
    tplCounts[p.templateId] = (tplCounts[p.templateId] ?? 0) + 1
  }

  const avgCost  = calc.length > 0 ? calc.reduce((s, p) => s + p.amazonCost, 0) / calc.length : 0
  const avgPrice = calc.length > 0 ? calc.reduce((s, p) => s + p.price,      0) / calc.length : 0
  const avgDesc  = payloads.reduce((s, p) => s + p.descriptionLength, 0) / payloads.length

  console.log("")
  console.log("  ► Stats")
  sep(50)
  console.log(`  ${"Total payloads".padEnd(26)} ${payloads.length}`)
  console.log(`  ${"Calculated pricing".padEnd(26)} ${calc.length}  ✓`)
  console.log(`  ${"Fallback pricing".padEnd(26)} ${fallb.length}  ~`)
  if (calc.length > 0) {
    console.log(`  ${"Avg Amazon Cost".padEnd(26)} ${usd(avgCost)}`)
    console.log(`  ${"Avg List Price".padEnd(26)} ${usd(avgPrice)}`)
    console.log(`  ${"Avg Uplift".padEnd(26)} +${((avgPrice - avgCost) / avgCost * 100).toFixed(1)}%`)
  }
  console.log(`  ${"Avg Description Length".padEnd(26)} ${Math.round(avgDesc)} chars`)
  console.log(`  ${"Templates used".padEnd(26)} ${Object.entries(tplCounts).map(([k, v]) => `${k}(${v})`).join(", ")}`)

  // ── Detaylı tek payload ───────────────────────────────────────

  const sample = calc[0] ?? payloads[0]
  if (sample) {
    console.log("")
    console.log(`  ► Sample Detail — ${sample.asin}`)
    sep(60)
    console.log(`  ${"pool_id".padEnd(24)} ${sample.poolId}`)
    console.log(`  ${"asin".padEnd(24)} ${sample.asin}`)
    console.log(`  ${"sku".padEnd(24)} ${sample.sku}`)
    console.log(`  ${"store".padEnd(24)} ${sample.storeName} (${sample.storeCode})`)
    console.log(`  ${"title".padEnd(24)} ${sample.title.slice(0, 52)}`)
    console.log(`  ${"brand".padEnd(24)} ${sample.brand}`)
    console.log(`  ${"amazon cost".padEnd(24)} ${usd(sample.amazonCost)}`)
    console.log(`  ${"list price".padEnd(24)} ${usd(sample.price)}`)
    console.log(`  ${"pricing source".padEnd(24)} ${sample.pricingSource}`)
    console.log(`  ${"template id".padEnd(24)} ${sample.templateId}`)
    console.log(`  ${"description length".padEnd(24)} ${sample.descriptionLength} chars`)
    console.log(`  ${"images".padEnd(24)} ${sample.images.length}`)
    console.log(`  ${"quantity".padEnd(24)} ${sample.quantity}`)
    console.log(`  ${"condition".padEnd(24)} ${sample.condition}`)
    console.log("")
    console.log("  ► Description Preview (first 200 chars)")
    sep(60)
    console.log(`  ${sample.description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}`)
  }

  // ── Final ─────────────────────────────────────────────────────

  console.log("")
  console.log("═".repeat(84))
  if (fallb.length > 0) {
    console.log(`  ⚠  ${fallb.length} fallback pricing — store_settings.enabled=true + amazon_product_cache.price gerekli`)
  }
  console.log(`  ✓ = calculated pricing   ~ = fallback ($${FALLBACK_PRICE})`)
  console.log("═".repeat(84))
}

const FALLBACK_PRICE = 19.99

main()
  .catch((err: unknown) => {
    console.error("[HATA]", err instanceof Error ? err.message : err)
    process.exit(1)
  })
  .finally(async () => {
    await closeDbPool()
  })
