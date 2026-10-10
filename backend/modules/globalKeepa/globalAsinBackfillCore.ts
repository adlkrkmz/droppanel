import { inspectListingAsin } from "../monitor/listingAsinResolve"
import { listingPriorityRank } from "./globalKeepaPriority"
import type { GlobalAsinConsumerRow } from "./globalKeepaTypes"
import type { AsinResolutionSource, UnresolvedAsinReason } from "../monitor/listingAsinResolve"

export type ResolvedConsumerLink = {
  catalogStateId: number
  workspaceId: string
  storeId: number
  asin: string
  listingPriority: 0 | 1 | 2
  resolutionSource: AsinResolutionSource
  currentStatus: string | null
  panelHiddenAt: string | null
  ebayItemId: string | null
}

export type UnresolvedConsumerSample = {
  catalogStateId: number
  workspaceId: string
  storeId: number
  ebayItemId: string | null
  sourceUrl: string | null
  internalSku: string
  asinRegistryId: number | null
  reason: UnresolvedAsinReason
}

export type BackfillBatchResult = {
  processed: number
  linked: number
  skippedNoAsin: number
  skippedAsin: UnresolvedConsumerSample[]
  links: ResolvedConsumerLink[]
  lastCatalogStateId: number | null
}

export function resolveConsumerLink(row: GlobalAsinConsumerRow): ResolvedConsumerLink | null {
  const inspected = inspectListingAsin({
    registryAsin: row.registryAsin,
    sourceUrl: row.sourceUrl,
    internalSku: row.internalSku,
  })
  if (!inspected.asin || !inspected.source) return null
  return {
    catalogStateId: row.catalogStateId,
    workspaceId: row.workspaceId,
    storeId: row.storeId,
    asin: inspected.asin,
    listingPriority: listingPriorityRank({
      totalSold: row.totalSold,
      sold30d: row.sold30d,
      clicks30d: row.clicks30d,
    }),
    resolutionSource: inspected.source,
    currentStatus: row.currentStatus,
    panelHiddenAt: row.panelHiddenAt,
    ebayItemId: row.ebayItemId,
  }
}

export function unresolvedSampleFromRow(row: GlobalAsinConsumerRow): UnresolvedConsumerSample {
  const inspected = inspectListingAsin({
    registryAsin: row.registryAsin,
    sourceUrl: row.sourceUrl,
    internalSku: row.internalSku,
  })
  return {
    catalogStateId: row.catalogStateId,
    workspaceId: row.workspaceId,
    storeId: row.storeId,
    ebayItemId: row.ebayItemId,
    sourceUrl: row.sourceUrl,
    internalSku: row.internalSku,
    asinRegistryId: row.asinRegistryId,
    reason: inspected.reason ?? "OTHER",
  }
}

export const GLOBAL_ASIN_BACKFILL_SELECT_SQL = `
SELECT scs.id AS catalog_state_id,
       scs.workspace_id::text AS workspace_id,
       scs.store_id,
       ar.asin AS registry_asin,
       scs.source_url,
       scs.internal_sku,
       scs.total_sold,
       scs.sold_30d,
       scs.clicks_30d,
       scs.ebay_item_id,
       scs.asin_registry_id,
       scs.current_status::text AS current_status,
       scs.panel_hidden_at::text AS panel_hidden_at
FROM store_catalog_state scs
LEFT JOIN asin_registry ar
  ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
WHERE scs.id > $1::bigint
ORDER BY scs.id ASC
LIMIT $2::int
`

export const UPSERT_GLOBAL_AMAZON_ASIN_SQL = `
INSERT INTO global_amazon_asins (keepa_domain, asin, priority, is_active, created_at, updated_at)
VALUES ($1::integer, $2::text, $3::smallint, TRUE, NOW(), NOW())
ON CONFLICT (keepa_domain, asin) DO UPDATE SET
  priority = LEAST(COALESCE(global_amazon_asins.priority, EXCLUDED.priority), EXCLUDED.priority),
  updated_at = NOW()
RETURNING id, (xmax = 0) AS inserted
`

export const UPSERT_GLOBAL_ASIN_CONSUMER_SQL = `
INSERT INTO global_asin_consumers (
  global_asin_id, workspace_id, store_id, catalog_state_id, listing_priority, created_at, updated_at
)
VALUES ($1::bigint, $2::uuid, $3::integer, $4::bigint, $5::smallint, NOW(), NOW())
ON CONFLICT (catalog_state_id) DO UPDATE SET
  global_asin_id = EXCLUDED.global_asin_id,
  workspace_id = EXCLUDED.workspace_id,
  store_id = EXCLUDED.store_id,
  listing_priority = EXCLUDED.listing_priority,
  updated_at = NOW()
RETURNING id, (xmax = 0) AS inserted
`

export function mapBackfillQueryRow(row: {
  catalog_state_id: number | string
  workspace_id: string
  store_id: number | string
  registry_asin: string | null
  source_url: string | null
  internal_sku: string | null
  total_sold: number | null
  sold_30d: number | null
  clicks_30d: number | null
  ebay_item_id?: string | null
  asin_registry_id?: number | string | null
  current_status?: string | null
  panel_hidden_at?: string | null
}): GlobalAsinConsumerRow {
  return {
    catalogStateId: Number(row.catalog_state_id),
    workspaceId: String(row.workspace_id),
    storeId: Number(row.store_id),
    registryAsin: row.registry_asin,
    sourceUrl: row.source_url,
    internalSku: row.internal_sku ?? "",
    totalSold: row.total_sold,
    sold30d: row.sold_30d,
    clicks30d: row.clicks_30d,
    ebayItemId: row.ebay_item_id?.trim() || null,
    asinRegistryId:
      row.asin_registry_id == null || row.asin_registry_id === ""
        ? null
        : Number(row.asin_registry_id),
    currentStatus: row.current_status?.trim() || null,
    panelHiddenAt: row.panel_hidden_at?.trim() || null,
  }
}

export function reduceBackfillBatch(
  rows: GlobalAsinConsumerRow[]
): { links: ResolvedConsumerLink[]; skipped: UnresolvedConsumerSample[] } {
  const links: ResolvedConsumerLink[] = []
  const skipped: UnresolvedConsumerSample[] = []
  for (const row of rows) {
    const link = resolveConsumerLink(row)
    if (!link) {
      skipped.push(unresolvedSampleFromRow(row))
      continue
    }
    links.push(link)
  }
  return { links, skipped }
}

export type BackfillDryRunMetrics = {
  totalCatalogRowsConsidered: number
  activeAmazonSourceListings: number
  asinResolved: number
  asinUnresolved: number
  resolvedViaRegistry: number
  resolvedViaSourceUrl: number
  resolvedViaSku: number
  uniqueGlobalAsins: number
  globalConsumersToCreate: number
  duplicateReusedAsins: number
  dedupSavingCount: number
  dedupSavingPercent: number
  unresolvedByReason: Record<UnresolvedAsinReason, number>
  unresolvedSamples: UnresolvedConsumerSample[]
}

function emptyUnresolvedReasons(): Record<UnresolvedAsinReason, number> {
  return {
    NO_REGISTRY: 0,
    NO_SOURCE_URL_ASIN: 0,
    NO_SKU_ASIN: 0,
    INVALID_ASIN_FORMAT: 0,
    OTHER: 0,
  }
}

export function emptyDryRunMetrics(): BackfillDryRunMetrics {
  return {
    totalCatalogRowsConsidered: 0,
    activeAmazonSourceListings: 0,
    asinResolved: 0,
    asinUnresolved: 0,
    resolvedViaRegistry: 0,
    resolvedViaSourceUrl: 0,
    resolvedViaSku: 0,
    uniqueGlobalAsins: 0,
    globalConsumersToCreate: 0,
    duplicateReusedAsins: 0,
    dedupSavingCount: 0,
    dedupSavingPercent: 0,
    unresolvedByReason: emptyUnresolvedReasons(),
    unresolvedSamples: [],
  }
}

function isActiveListing(link: ResolvedConsumerLink): boolean {
  const status = (link.currentStatus ?? "live").toLowerCase()
  return status === "live" && !link.panelHiddenAt
}

export function accumulateDryRunMetrics(
  metrics: BackfillDryRunMetrics,
  batch: { links: ResolvedConsumerLink[]; skipped: UnresolvedConsumerSample[]; processed: number },
  uniqueAsinKeys: Set<string>,
  asinConsumerCounts: Map<string, number>,
  keepaDomain: number,
  sampleLimit = 50
): void {
  metrics.totalCatalogRowsConsidered += batch.processed
  metrics.asinResolved += batch.links.length
  metrics.asinUnresolved += batch.skipped.length
  metrics.globalConsumersToCreate += batch.links.length

  for (const link of batch.links) {
    if (isActiveListing(link)) metrics.activeAmazonSourceListings++
    if (link.resolutionSource === "REGISTRY") metrics.resolvedViaRegistry++
    else if (link.resolutionSource === "SOURCE_URL") metrics.resolvedViaSourceUrl++
    else metrics.resolvedViaSku++
    const key = `${keepaDomain}:${link.asin}`
    uniqueAsinKeys.add(key)
    asinConsumerCounts.set(key, (asinConsumerCounts.get(key) ?? 0) + 1)
  }

  for (const miss of batch.skipped) {
    metrics.unresolvedByReason[miss.reason]++
    if (metrics.unresolvedSamples.length < sampleLimit) {
      metrics.unresolvedSamples.push(miss)
    }
  }
}

export function finalizeDryRunMetrics(
  metrics: BackfillDryRunMetrics,
  uniqueAsinKeys: Set<string>,
  asinConsumerCounts: Map<string, number>
): BackfillDryRunMetrics {
  metrics.uniqueGlobalAsins = uniqueAsinKeys.size
  metrics.duplicateReusedAsins = [...asinConsumerCounts.values()].filter(n => n > 1).length
  metrics.dedupSavingCount = Math.max(0, metrics.asinResolved - metrics.uniqueGlobalAsins)
  metrics.dedupSavingPercent =
    metrics.asinResolved > 0
      ? Math.round((metrics.dedupSavingCount / metrics.asinResolved) * 10000) / 100
      : 0
  return metrics
}

export function assertDryRunInvariants(input: {
  links: ResolvedConsumerLink[]
  uniqueAsinCount: number
  keepaDomain: number
}): { ok: true } | { ok: false; failed: string[] } {
  const failed: string[] = []
  const catalogIds = new Set<number>()
  for (const link of input.links) {
    if (catalogIds.has(link.catalogStateId)) {
      failed.push(`INVARIANT_D duplicate catalog_state_id=${link.catalogStateId}`)
    }
    catalogIds.add(link.catalogStateId)
    if (!link.asin) failed.push(`INVARIANT_A missing asin catalog=${link.catalogStateId}`)
  }
  const unique = new Set(input.links.map(l => `${input.keepaDomain}:${l.asin}`))
  if (unique.size !== input.uniqueAsinCount) {
    failed.push("INVARIANT_B unique key mismatch")
  }
  return failed.length === 0 ? { ok: true } : { ok: false, failed }
}
