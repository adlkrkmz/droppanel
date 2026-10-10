import { query } from "../../db/client"
import { loadGlobalKeepaFoundationConfig } from "./globalKeepaConfig"
import {
  GLOBAL_ASIN_BACKFILL_SELECT_SQL,
  UPSERT_GLOBAL_AMAZON_ASIN_SQL,
  UPSERT_GLOBAL_ASIN_CONSUMER_SQL,
  accumulateDryRunMetrics,
  assertDryRunInvariants,
  emptyDryRunMetrics,
  finalizeDryRunMetrics,
  mapBackfillQueryRow,
  reduceBackfillBatch,
  type BackfillBatchResult,
  type BackfillDryRunMetrics,
} from "./globalAsinBackfillCore"

type CatalogQueryRow = {
  catalog_state_id: number | string
  workspace_id: string
  store_id: number | string
  registry_asin: string | null
  source_url: string | null
  internal_sku: string | null
  total_sold: number | null
  sold_30d: number | null
  clicks_30d: number | null
  ebay_item_id: string | null
  asin_registry_id: number | string | null
  current_status: string | null
  panel_hidden_at: string | null
}

export type GlobalAsinBackfillOptions = {
  batchSize?: number
  resumeAfterId?: number
  dryRun?: boolean
  maxBatches?: number
}

export type GlobalAsinBackfillSummary = {
  dryRun: boolean
  batches: number
  processed: number
  linked: number
  skippedNoAsin: number
  lastCatalogStateId: number | null
  done: boolean
  globalAsinsCreated: number
  globalAsinsReused: number
  consumersCreated: number
  consumersUpdated: number
  consumersSkipped: number
  errors: number
  metrics: BackfillDryRunMetrics
  invariantOk: boolean
  invariantFailures: string[]
}

/**
 * Idempotent bounded backfill. Does not run unless a caller invokes it.
 * Never mutates eBay or Keepa. Does not overwrite store_catalog_state.source_price.
 */
export async function runGlobalAsinBackfillBatch(
  options: GlobalAsinBackfillOptions = {}
): Promise<BackfillBatchResult & { globalAsinsCreated: number; globalAsinsReused: number; consumersCreated: number; consumersUpdated: number; errors: number }> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 500, 5000))
  const resumeAfterId = Math.max(0, options.resumeAfterId ?? 0)
  const dryRun = options.dryRun === true
  const domain = loadGlobalKeepaFoundationConfig().keepaDomain

  const res = await query<CatalogQueryRow>(GLOBAL_ASIN_BACKFILL_SELECT_SQL, [
    resumeAfterId,
    batchSize,
  ])
  const rows = res.rows.map(mapBackfillQueryRow)
  const { links, skipped } = reduceBackfillBatch(rows)
  const lastCatalogStateId =
    rows.length > 0 ? rows[rows.length - 1]!.catalogStateId : resumeAfterId || null

  let globalAsinsCreated = 0
  let globalAsinsReused = 0
  let consumersCreated = 0
  let consumersUpdated = 0
  let errors = 0

  if (!dryRun) {
    for (const link of links) {
      try {
        const asinRes = await query<{ id: number; inserted: boolean }>(UPSERT_GLOBAL_AMAZON_ASIN_SQL, [
          domain,
          link.asin,
          link.listingPriority,
        ])
        const globalAsinId = Number(asinRes.rows[0]?.id)
        if (!Number.isFinite(globalAsinId)) {
          errors++
          continue
        }
        if (asinRes.rows[0]?.inserted) globalAsinsCreated++
        else globalAsinsReused++

        const cons = await query<{ id: number; inserted: boolean }>(UPSERT_GLOBAL_ASIN_CONSUMER_SQL, [
          globalAsinId,
          link.workspaceId,
          link.storeId,
          link.catalogStateId,
          link.listingPriority,
        ])
        if (cons.rows[0]?.inserted) consumersCreated++
        else consumersUpdated++
      } catch (e) {
        errors++
        console.error(
          `[GlobalKeepaBackfill] upsert failed catalogStateId=${link.catalogStateId}:`,
          e instanceof Error ? e.message : e
        )
      }
    }
  }

  if (skipped.length > 0 && skipped.length <= 20) {
    for (const miss of skipped) {
      console.warn(
        `[GlobalKeepaBackfill] skippedNoAsin catalogStateId=${miss.catalogStateId} reason=${miss.reason} workspace=${miss.workspaceId} storeId=${miss.storeId}`
      )
    }
  } else if (skipped.length > 20) {
    console.warn(`[GlobalKeepaBackfill] skippedNoAsin count=${skipped.length} (samples logged in metrics)`)
  }

  return {
    processed: rows.length,
    linked: links.length,
    skippedNoAsin: skipped.length,
    skippedAsin: skipped,
    links,
    lastCatalogStateId,
    globalAsinsCreated,
    globalAsinsReused,
    consumersCreated,
    consumersUpdated,
    errors,
  }
}

export async function runGlobalAsinBackfill(
  options: GlobalAsinBackfillOptions = {}
): Promise<GlobalAsinBackfillSummary> {
  const dryRun = options.dryRun === true
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY
  const keepaDomain = loadGlobalKeepaFoundationConfig().keepaDomain
  let resumeAfterId = options.resumeAfterId ?? 0
  let batches = 0
  let processed = 0
  let linked = 0
  let skippedNoAsin = 0
  let lastCatalogStateId: number | null = resumeAfterId || null
  let globalAsinsCreated = 0
  let globalAsinsReused = 0
  let consumersCreated = 0
  let consumersUpdated = 0
  let errors = 0
  const metrics = emptyDryRunMetrics()
  const uniqueAsinKeys = new Set<string>()
  const asinConsumerCounts = new Map<string, number>()
  const allLinks: BackfillBatchResult["links"] = []

  while (batches < maxBatches) {
    const batch = await runGlobalAsinBackfillBatch({
      ...options,
      resumeAfterId,
      dryRun,
    })
    batches++
    processed += batch.processed
    linked += batch.linked
    skippedNoAsin += batch.skippedNoAsin
    lastCatalogStateId = batch.lastCatalogStateId
    globalAsinsCreated += batch.globalAsinsCreated
    globalAsinsReused += batch.globalAsinsReused
    consumersCreated += batch.consumersCreated
    consumersUpdated += batch.consumersUpdated
    errors += batch.errors
    allLinks.push(...batch.links)
    accumulateDryRunMetrics(
      metrics,
      {
        links: batch.links,
        skipped: batch.skippedAsin,
        processed: batch.processed,
      },
      uniqueAsinKeys,
      asinConsumerCounts,
      keepaDomain
    )
    console.log(
      `[GlobalKeepaBackfill] batch=${batches} processed=${batch.processed} linked=${batch.linked} skippedNoAsin=${batch.skippedNoAsin} lastId=${batch.lastCatalogStateId} dryRun=${dryRun}`
    )
    if (batch.processed === 0) break
    resumeAfterId = batch.lastCatalogStateId ?? resumeAfterId
    if (batch.processed < (options.batchSize ?? 500)) break
  }

  finalizeDryRunMetrics(metrics, uniqueAsinKeys, asinConsumerCounts)
  const invariants = assertDryRunInvariants({
    links: allLinks,
    uniqueAsinCount: uniqueAsinKeys.size,
    keepaDomain,
  })

  return {
    dryRun,
    batches,
    processed,
    linked,
    skippedNoAsin,
    lastCatalogStateId,
    done: true,
    globalAsinsCreated,
    globalAsinsReused,
    consumersCreated,
    consumersUpdated,
    consumersSkipped: skippedNoAsin,
    errors,
    metrics,
    invariantOk: invariants.ok,
    invariantFailures: invariants.ok ? [] : invariants.failed,
  }
}
