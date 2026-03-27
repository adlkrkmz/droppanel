import "dotenv/config"
import { query, closeDbPool } from "./db/client"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) throw new Error("WORKSPACE_ID is not defined in .env")
const WORKSPACE_ID: string = workspaceId

// ─── UNIQUE ASIN ÜRETICI ──────────────────────────────────────

function generateUniqueAsins(count: number): string[] {
  const base   = Date.now()
  const rand   = Math.floor(Math.random() * 1000)
  const asins: string[] = []
  for (let i = 0; i < count; i++) {
    const suffix = String(base * 1000 + rand * 10 + i).slice(-9)
    asins.push(`B0DSP${suffix}`)
  }
  return asins
}

// ─── FAKE DATA BUILDERS ───────────────────────────────────────

function fakePrice(asin: string): number {
  const seed = asin.split("").reduce((s, c) => s + c.charCodeAt(0), 0)
  return Math.round((15 + (seed % 85) + 0.99) * 100) / 100
}

function fakeImages(asin: string): string[] {
  return [
    `https://example.com/images/${asin}-1.jpg`,
    `https://example.com/images/${asin}-2.jpg`,
    `https://example.com/images/${asin}-3.jpg`,
  ]
}

function fakeAttributes(asin: string): Record<string, string> {
  return {
    asin,
    color:    "Black",
    material: "ABS Plastic",
    pack:     "1 Pack",
    source:   "fixture",
  }
}

// ─── HELPERS ──────────────────────────────────────────────────

function sep(len = 72): void {
  console.log("  " + "─".repeat(len))
}

// ─── MAIN ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const ASINS = generateUniqueAsins(5)

  console.log("═".repeat(72))
  console.log("  test-dispatch-fixture")
  console.log("═".repeat(72))
  console.log(`  workspace : ${WORKSPACE_ID}`)
  console.log(`  new asins : ${ASINS.join("  ")}`)
  console.log("")

  type ResultRow = {
    asin:        string
    registryId:  number | null
    poolId:      number | null
    cachePrice:  number | null
    action:      "inserted" | "skipped"
    reason:      string
  }

  const results: ResultRow[] = []

  for (const asin of ASINS) {
    // ── 1. Çakışma kontrolü ───────────────────────────────────
    const existing = await query<{ id: number }>(
      `SELECT id FROM asin_registry
       WHERE workspace_id = $1 AND asin = $2
       LIMIT 1`,
      [WORKSPACE_ID, asin]
    )

    if (existing.rows.length > 0) {
      results.push({
        asin,
        registryId: existing.rows[0].id,
        poolId:     null,
        cachePrice: null,
        action:     "skipped",
        reason:     "already in asin_registry"
      })
      continue
    }

    // ── 2. asin_registry ──────────────────────────────────────
    const registryInsert = await query<{ id: number }>(
      `INSERT INTO asin_registry (
         workspace_id, asin, title, brand, global_status, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
       RETURNING id`,
      [WORKSPACE_ID, asin, `Fixture Product ${asin}`, "FixtureBrand"]
    )

    const registryId = registryInsert.rows[0]?.id
    if (!registryId) {
      results.push({
        asin, registryId: null, poolId: null, cachePrice: null,
        action: "skipped", reason: "registry insert returned no id"
      })
      continue
    }

    // ── 3. amazon_product_cache ───────────────────────────────
    const price      = fakePrice(asin)
    const images     = fakeImages(asin)
    const attributes = fakeAttributes(asin)

    await query(
      `INSERT INTO amazon_product_cache (
         asin_registry_id,
         title,
         brand,
         price,
         images,
         attributes,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())
       ON CONFLICT (asin_registry_id)
       DO UPDATE SET
         title      = EXCLUDED.title,
         brand      = EXCLUDED.brand,
         price      = EXCLUDED.price,
         images     = EXCLUDED.images,
         attributes = EXCLUDED.attributes,
         updated_at = NOW()`,
      [
        registryId,
        `Fixture Product ${asin}`,
        "FixtureBrand",
        price,
        JSON.stringify(images),
        JSON.stringify(attributes),
      ]
    )

    // ── 4. asin_pool ──────────────────────────────────────────
    const poolInsert = await query<{ id: number }>(
      `INSERT INTO asin_pool (
         workspace_id,
         asin_registry_id,
         status,
         pipeline_stage,
         scrape_status,
         ai_status,
         listing_status,
         assigned_store_id,
         priority,
         created_at,
         updated_at
       )
       VALUES ($1, $2,
         'ready', 'ai_generated', 'success', 'success', 'pending',
         NULL, 0, NOW(), NOW()
       )
       RETURNING id`,
      [WORKSPACE_ID, registryId]
    )

    const poolId = poolInsert.rows[0]?.id ?? null

    results.push({
      asin, registryId, poolId, cachePrice: price,
      action: "inserted", reason: "ok"
    })
  }

  // ── Sonuç tablosu ─────────────────────────────────────────────

  const inserted = results.filter(r => r.action === "inserted")
  const skipped  = results.filter(r => r.action === "skipped")

  console.log(
    `  ${"".padEnd(3)}` +
    `${"ASIN".padEnd(15)}` +
    `${"registry_id".padEnd(14)}` +
    `${"pool_id".padEnd(10)}` +
    `${"cache_price".padEnd(12)}` +
    `Durum`
  )
  sep()

  for (const r of results) {
    const icon = r.action === "inserted" ? "✓" : "—"
    console.log(
      `  ${icon.padEnd(3)}` +
      `${r.asin.padEnd(15)}` +
      `${String(r.registryId ?? "-").padEnd(14)}` +
      `${String(r.poolId    ?? "-").padEnd(10)}` +
      `${r.cachePrice !== null ? ("$" + r.cachePrice.toFixed(2)).padEnd(12) : "-".padEnd(12)}` +
      `${r.action === "inserted" ? "inserted" : `skipped — ${r.reason}`}`
    )
  }

  console.log("")
  console.log("═".repeat(72))
  console.log(`  Eklenen : ${inserted.length} ASIN  (registry + pool + amazon_product_cache)`)
  console.log(`  Atlanan : ${skipped.length} ASIN`)
  if (inserted.length > 0) {
    console.log("")
    console.log("  Sonraki adım:")
    console.log("    npx ts-node test-dispatch-engine.ts")
    console.log("    npx ts-node test-ebay-payload.ts")
  }
  console.log("═".repeat(72))
}

main()
  .catch((err: unknown) => {
    console.error("[HATA]", err instanceof Error ? err.message : err)
    process.exit(1)
  })
  .finally(async () => {
    await closeDbPool()
  })
