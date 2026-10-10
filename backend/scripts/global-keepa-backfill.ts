/**
 * Idempotent global ASIN consumer backfill.
 * Default is dry-run. Refuses to run without --execute.
 * Does not call Keepa or eBay.
 *
 * Usage:
 *   npm run global-keepa:backfill
 *   npm run global-keepa:backfill:execute
 */
import "dotenv/config"
import { runGlobalAsinBackfill } from "../modules/globalKeepa/globalAsinBackfillService"

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  if (i < 0) return undefined
  return process.argv[i + 1]
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

function printMetrics(label: string, summary: Awaited<ReturnType<typeof runGlobalAsinBackfill>>): void {
  const m = summary.metrics
  console.log(`\n===== ${label} =====`)
  console.log(`TOTAL CATALOG ROWS CONSIDERED: ${m.totalCatalogRowsConsidered}`)
  console.log(`ACTIVE AMAZON-SOURCE LISTINGS: ${m.activeAmazonSourceListings}`)
  console.log(`ASIN RESOLVED: ${m.asinResolved}`)
  console.log(`ASIN UNRESOLVED: ${m.asinUnresolved}`)
  console.log(`RESOLVED VIA REGISTRY: ${m.resolvedViaRegistry}`)
  console.log(`RESOLVED VIA SOURCE_URL: ${m.resolvedViaSourceUrl}`)
  console.log(`RESOLVED VIA SKU: ${m.resolvedViaSku}`)
  console.log(`UNIQUE GLOBAL ASINS: ${m.uniqueGlobalAsins}`)
  console.log(`GLOBAL CONSUMERS TO CREATE: ${m.globalConsumersToCreate}`)
  console.log(`DUPLICATE/REUSED ASINS: ${m.duplicateReusedAsins}`)
  console.log(`DEDUP SAVING COUNT: ${m.dedupSavingCount}`)
  console.log(`DEDUP SAVING PERCENT: ${m.dedupSavingPercent}`)
  console.log(`INVARIANT_OK: ${summary.invariantOk}`)
  if (!summary.invariantOk) console.log(`INVARIANT_FAILURES: ${summary.invariantFailures.join("; ")}`)
  console.log("UNRESOLVED BY REASON:", JSON.stringify(m.unresolvedByReason))
  console.log("UNRESOLVED SAMPLES (max 50):")
  for (const s of m.unresolvedSamples) {
    console.log(
      JSON.stringify({
        workspace_id: s.workspaceId,
        store_id: s.storeId,
        catalog_state_id: s.catalogStateId,
        ebay_item_id: s.ebayItemId,
        source_url: s.sourceUrl,
        internal_sku: s.internalSku,
        asin_registry_id: s.asinRegistryId,
        reason: s.reason,
      })
    )
  }
  console.log("EXECUTE", {
    globalAsinsCreated: summary.globalAsinsCreated,
    globalAsinsReused: summary.globalAsinsReused,
    consumersCreated: summary.consumersCreated,
    consumersUpdated: summary.consumersUpdated,
    consumersSkipped: summary.consumersSkipped,
    unresolved: summary.skippedNoAsin,
    errors: summary.errors,
  })
}

async function main(): Promise<void> {
  const execute = hasFlag("--execute")
  const dryRun = !execute
  const batchSize = parseInt(argValue("--batch-size") ?? "500", 10)
  const resumeAfterId = parseInt(argValue("--resume-after-id") ?? "0", 10)
  const maxBatchesRaw = argValue("--max-batches")
  const maxBatches = maxBatchesRaw ? parseInt(maxBatchesRaw, 10) : undefined

  if (!execute) {
    console.log("[GlobalKeepaBackfill] dry-run (pass --execute to write). No Keepa/eBay calls.")
  }

  const summary = await runGlobalAsinBackfill({
    dryRun,
    batchSize: Number.isFinite(batchSize) ? batchSize : 500,
    resumeAfterId: Number.isFinite(resumeAfterId) ? resumeAfterId : 0,
    maxBatches: maxBatches != null && Number.isFinite(maxBatches) ? maxBatches : undefined,
  })

  printMetrics(dryRun ? "DRY-RUN" : "EXECUTE", summary)
  console.log("[GlobalKeepaBackfill] summary", {
    dryRun: summary.dryRun,
    batches: summary.batches,
    processed: summary.processed,
    linked: summary.linked,
    skippedNoAsin: summary.skippedNoAsin,
    done: summary.done,
    errors: summary.errors,
    invariantOk: summary.invariantOk,
  })
  if (!summary.invariantOk || summary.errors > 0) process.exitCode = 1
}

void main().catch(err => {
  console.error("[GlobalKeepaBackfill] failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
