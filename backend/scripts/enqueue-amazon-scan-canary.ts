import "dotenv/config"
import fs from "fs"
import { enqueueScanJob } from "../modules/amazonScan/amazonScanJobQueue"
import { loadAmazonScanConfig } from "../modules/amazonScan/amazonScanConfig"
import { query } from "../db/client"

async function main(): Promise<void> {
  const cfg = loadAmazonScanConfig()
  if (cfg.plannerEnabled) throw new Error("planner must be false")
  if (cfg.applyProcessorEnabled) throw new Error("apply must be false")
  const asins = fs
    .readFileSync("/home/listjetgo/amazon-scan-bench-asins.txt", "utf8")
    .split(/\s+/)
    .map(s => s.trim().toUpperCase())
    .filter(s => /^[A-Z0-9]{10}$/.test(s))
  if (asins.length !== 8) throw new Error(`need 8 asins, got ${asins.length}`)
  const op = `CANARY_${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`
  const found = await query<{ id: string; asin: string }>(
    `SELECT g.id::text AS id, g.asin
     FROM global_amazon_asins g
     WHERE g.asin = ANY($1::text[])`,
    [asins]
  )
  const byAsin = new Map(found.rows.map(r => [r.asin.toUpperCase(), Number(r.id)]))
  const missing = asins.filter(a => !byAsin.has(a))
  if (missing.length) throw new Error(`missing global ASIN rows: ${missing.join(",")}`)
  const created: number[] = []
  for (const asin of asins) {
    const made = await enqueueScanJob({
      globalAsinId: byAsin.get(asin)!,
      asin,
      marketplace: cfg.marketplace,
      deliveryZip: cfg.deliveryZip,
      sessionClass: op,
      kind: "ROUTINE",
      priority: 0,
      requireFreshNav: true,
    })
    if (!made.created || !made.jobId) throw new Error(`enqueue failed for ${asin} jobId=${made.jobId}`)
    created.push(made.jobId)
  }
  console.log(JSON.stringify({ op, createdCount: created.length, jobIds: created, asins }))
}

void main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
