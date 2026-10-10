import "dotenv/config"
import { db, query } from "../db/client"
import { EbayApiClient } from "../modules/ebay/ebayApiClient"
import { getValidAccessToken } from "../modules/ebayOAuth/ebayOAuthService"
import {
  getRecommendedPriceForListing,
  persistCatalogEbayPrice,
  updateListingPriceOnEbay,
} from "../modules/listings/listingsEbayPriceService"
import { emitActivityEvent, findActivityByIdempotencyKey } from "../modules/activity/activityEventService"

/**
 * One-time repair for the explicitly bounded legacy false-success population.
 * It never selects bucket A and never writes historical operation rows.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/reconcile-legacy-ebay-price-false-success.ts --dry-run
 *   npx ts-node --transpile-only scripts/reconcile-legacy-ebay-price-false-success.ts --apply
 */

const LEGACY_CUTOFF = "2026-10-10T11:23:14Z"
const CONCURRENCY = 2
const APPLY = process.argv.includes("--apply")
const DRY_RUN = process.argv.includes("--dry-run")
const offsetArg = process.argv.find(arg => arg.startsWith("--offset="))
const limitArg = process.argv.find(arg => arg.startsWith("--limit="))
const OFFSET = Math.max(0, Number(offsetArg?.slice("--offset=".length) ?? 0) || 0)
const LIMIT = Math.max(1, Number(limitArg?.slice("--limit=".length) ?? Number.MAX_SAFE_INTEGER) || Number.MAX_SAFE_INTEGER)
const onlyArg = process.argv.find(arg => arg.startsWith("--only-catalog-ids="))
const ONLY_IDS = new Set((onlyArg?.slice("--only-catalog-ids=".length) ?? "").split(",").map(Number).filter(Number.isFinite))
const TECHNICAL_ALLOWLIST = new Set([6293,7267,7653,8694,13355,2834,7587,19877,20062,27062,27559,9494])
const STORE_MISMATCH_IDS = new Set([2382,9311,9363,10880,10881])

if (APPLY === DRY_RUN) {
  throw new Error("Specify exactly one of --dry-run or --apply")
}
if (APPLY && (process.env.EBAY_SIMULATION ?? "").trim().toLowerCase() === "true") {
  throw new Error("EBAY_SIMULATION=true — refusing live reconciliation")
}

type Bucket = "B" | "C" | "D"
type Candidate = {
  bucket: Bucket
  catalogStateId: number
  workspaceId: string
  storeId: number
  storeCode: string
  asin: string | null
  ebayItemId: string | null
  internalSku: string | null
  ebayOfferId: string | null
  localEbayPrice: number | null
  sourcePrice: number | null
  currentStatus: string | null
}

type Outcome =
  | "MATCHED"
  | "UNDER_TARGET"
  | "ABOVE_TARGET"
  | "NO_CURRENT_PRICE_ACTION_REQUIRED"
  | "INACTIVE"
  | "REMOTE_READ_FAILED"
  | "SUBMITTED"
  | "FAILED_TO_SUBMIT"
  | "SKIPPED_DUPLICATE_OPERATION"

type Result = Candidate & {
  outcome: Outcome
  remotePrice: number | null
  targetPrice: number | null
  sourcePriceNow: number | null
  operationId: number | null
  error: string | null
}

function money(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function sameCents(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100)
}

function activeStatus(status: string | null | undefined): boolean {
  const normalized = String(status ?? "").trim().toUpperCase()
  return normalized === "" || normalized === "ACTIVE" || normalized === "LIVE"
}

async function loadCandidates(): Promise<Candidate[]> {
  const res = await query<{
    bucket: Bucket
    catalog_state_id: string
    workspace_id: string
    store_id: string
    store_code: string
    asin: string | null
    ebay_item_id: string | null
    internal_sku: string | null
    ebay_offer_id: string | null
    ebay_price: string | null
    source_price: string | null
    current_status: string | null
  }>(
    `WITH old AS (
       SELECT DISTINCT ON (catalog_state_id)
              catalog_state_id, created_at AS operation_at,
              NULLIF(after_data->>'ebay', '')::numeric AS target_price
       FROM workspace_activity_events
       WHERE event_type = 'PRICE_PROTECTION_APPLIED'
         AND created_at < $1::timestamptz
       ORDER BY catalog_state_id, created_at DESC
     ), classified AS (
       SELECT o.catalog_state_id,
              CASE
                WHEN o.target_price IS NULL OR o.target_price <= 0 THEN 'E'
                WHEN scs.ebay_price_synced_at IS NULL OR scs.ebay_price_synced_at <= o.operation_at THEN 'C'
                WHEN COALESCE(scs.auto_price_protected_at, scs.manual_price_updated_at) > scs.ebay_price_synced_at
                  OR COALESCE(scs.manual_price_updated_at, scs.auto_price_protected_at) > scs.ebay_price_synced_at THEN 'D'
                WHEN round(scs.ebay_price::numeric, 2) = round(o.target_price, 2) THEN 'A'
                ELSE 'B'
              END AS bucket
       FROM old o
       JOIN store_catalog_state scs ON scs.id = o.catalog_state_id
       WHERE lower(COALESCE(scs.current_status::text, 'live')) = 'live'
     )
     SELECT classified.bucket, scs.id::text AS catalog_state_id, scs.workspace_id::text,
            scs.store_id::text, s.store_code, COALESCE(ar.asin, e.asin) AS asin,
            scs.ebay_item_id, scs.internal_sku, scs.ebay_offer_id,
            scs.ebay_price::text, scs.source_price::text, scs.current_status::text
     FROM classified
     JOIN store_catalog_state scs ON scs.id = classified.catalog_state_id
     JOIN stores s ON s.id = scs.store_id AND s.workspace_id = scs.workspace_id
     LEFT JOIN asin_registry ar ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     LEFT JOIN LATERAL (
       SELECT asin FROM workspace_activity_events e
       WHERE e.catalog_state_id = scs.id AND e.event_type = 'PRICE_PROTECTION_APPLIED'
       ORDER BY e.created_at DESC LIMIT 1
     ) e ON true
     WHERE classified.bucket IN ('B', 'C', 'D')
     ORDER BY classified.bucket, scs.id`,
    [LEGACY_CUTOFF]
  )
  return res.rows.map(row => ({
    bucket: row.bucket,
    catalogStateId: Number(row.catalog_state_id),
    workspaceId: row.workspace_id,
    storeId: Number(row.store_id),
    storeCode: row.store_code,
    asin: row.asin,
    ebayItemId: row.ebay_item_id?.trim() || null,
    internalSku: row.internal_sku?.trim() || null,
    ebayOfferId: row.ebay_offer_id?.trim() || null,
    localEbayPrice: money(row.ebay_price),
    sourcePrice: money(row.source_price),
    currentStatus: row.current_status,
  }))
}

const clientCache = new Map<string, Promise<EbayApiClient>>()
function tradingClient(candidate: Candidate): Promise<EbayApiClient> {
  const key = `${candidate.workspaceId}:${candidate.storeCode}`
  let client = clientCache.get(key)
  if (!client) {
    client = getValidAccessToken(candidate.workspaceId, candidate.storeCode, false).then(token =>
      new EbayApiClient({
        oauthToken: token,
        sandbox: (process.env.EBAY_SANDBOX ?? "true") !== "false",
        simulationMode: false,
      })
    )
    clientCache.set(key, client)
  }
  return client
}

async function rereadCandidate(candidate: Candidate): Promise<Candidate | null> {
  const res = await query<{
    ebay_item_id: string | null; internal_sku: string | null; ebay_offer_id: string | null
    ebay_price: string | null; source_price: string | null; current_status: string | null
  }>(
    `SELECT ebay_item_id, internal_sku, ebay_offer_id, ebay_price::text, source_price::text,
            current_status::text
     FROM store_catalog_state
     WHERE workspace_id = $1::uuid AND store_id = $2::bigint AND id = $3::bigint
     LIMIT 1`,
    [candidate.workspaceId, candidate.storeId, candidate.catalogStateId]
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    ...candidate,
    ebayItemId: row.ebay_item_id?.trim() || null,
    internalSku: row.internal_sku?.trim() || null,
    ebayOfferId: row.ebay_offer_id?.trim() || null,
    localEbayPrice: money(row.ebay_price),
    sourcePrice: money(row.source_price),
    currentStatus: row.current_status,
  }
}

function emptyResult(candidate: Candidate, outcome: Outcome, error: string | null = null): Result {
  return { ...candidate, outcome, remotePrice: null, targetPrice: null, sourcePriceNow: candidate.sourcePrice, operationId: null, error }
}

async function processCandidate(original: Candidate): Promise<Result> {
  const candidate = await rereadCandidate(original)
  if (!candidate || !activeStatus(candidate.currentStatus) || !candidate.ebayItemId) {
    return emptyResult(original, "INACTIVE")
  }

  let recommendation: Awaited<ReturnType<typeof getRecommendedPriceForListing>>
  try {
    recommendation = await getRecommendedPriceForListing(candidate.workspaceId, candidate.storeCode, candidate.catalogStateId)
  } catch (error) {
    return emptyResult(candidate, "NO_CURRENT_PRICE_ACTION_REQUIRED", error instanceof Error ? error.message : String(error))
  }
  const target = recommendation.recommendedEbayPrice
  const source = recommendation.amazonPrice

  let snapshot
  try {
    snapshot = await (await tradingClient(candidate)).getTradingItemSnapshot(candidate.ebayItemId)
  } catch (error) {
    return { ...emptyResult(candidate, "REMOTE_READ_FAILED", error instanceof Error ? error.message : String(error)), targetPrice: target, sourcePriceNow: source }
  }
  if (!snapshot) {
    return { ...emptyResult(candidate, "REMOTE_READ_FAILED", "Trading GetItem returned no snapshot"), targetPrice: target, sourcePriceNow: source }
  }
  if (!activeStatus(snapshot.listingStatus)) {
    return { ...emptyResult(candidate, "INACTIVE"), remotePrice: money(snapshot.currentPrice ?? snapshot.startPrice), targetPrice: target, sourcePriceNow: source }
  }
  const remote = money(snapshot.currentPrice ?? snapshot.startPrice)
  if (remote == null) {
    return { ...emptyResult(candidate, "REMOTE_READ_FAILED", "Trading GetItem returned no current price"), targetPrice: target, sourcePriceNow: source }
  }
  if (sameCents(remote, target)) {
    return { ...emptyResult(candidate, "MATCHED"), remotePrice: remote, targetPrice: target, sourcePriceNow: source }
  }
  if (remote > target) {
    return { ...emptyResult(candidate, "ABOVE_TARGET"), remotePrice: remote, targetPrice: target, sourcePriceNow: source }
  }

  if (!APPLY) {
    return { ...emptyResult(candidate, "UNDER_TARGET"), remotePrice: remote, targetPrice: target, sourcePriceNow: source }
  }

  const operationKey = `legacy-price-reconcile:${candidate.catalogStateId}:${Math.round(target * 100)}`
  const existing = await findActivityByIdempotencyKey(candidate.workspaceId, operationKey)
  if (existing) {
    return { ...emptyResult(candidate, "SKIPPED_DUPLICATE_OPERATION"), remotePrice: remote, targetPrice: target, sourcePriceNow: source, operationId: existing.id }
  }

  try {
    // The normal corrected service repeats the Trading check, chooses the correct
    // Inventory/Trading mutation route, and verifies GetItem before returning.
    const update = await updateListingPriceOnEbay(candidate.workspaceId, candidate.storeCode, {
      internalSku: candidate.internalSku,
      ebayItemId: candidate.ebayItemId,
      ebayOfferId: candidate.ebayOfferId,
      newPrice: target,
      catalogStateId: candidate.catalogStateId,
      storeId: candidate.storeId,
      listingLive: true,
    })
    if (!sameCents(update.readbackPrice, target)) {
      throw new Error("Corrected price service returned a non-target Trading readback")
    }
    await persistCatalogEbayPrice({
      workspaceId: candidate.workspaceId,
      storeId: candidate.storeId,
      catalogStateId: candidate.catalogStateId,
      newPrice: update.readbackPrice,
      oldPrice: candidate.localEbayPrice,
      autoReason: "Legacy false-success reconciliation (Trading verified)",
    })
    const eventId = await emitActivityEvent({
      workspaceId: candidate.workspaceId,
      storeId: candidate.storeId,
      eventType: "PRICE_PROTECTION_APPLIED",
      severity: "success",
      title: "LEGACY PRICE RECONCILIATION APPLIED",
      message: `Trading verified eBay price $${remote.toFixed(2)} → $${update.readbackPrice.toFixed(2)}.`,
      catalogStateId: candidate.catalogStateId,
      asin: candidate.asin,
      ebayItemId: candidate.ebayItemId,
      beforeData: { amazon: source, ebay: remote },
      afterData: { amazon: source, ebay: update.readbackPrice, reconciliation: "legacy_false_success" },
      source: "legacy_price_reconciliation",
      idempotencyKey: operationKey,
    })
    return { ...emptyResult(candidate, "SUBMITTED"), remotePrice: remote, targetPrice: target, sourcePriceNow: source, operationId: eventId }
  } catch (error) {
    return { ...emptyResult(candidate, "FAILED_TO_SUBMIT", error instanceof Error ? error.message : String(error)), remotePrice: remote, targetPrice: target, sourcePriceNow: source }
  }
}

async function mapBounded<T, R>(values: T[], worker: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, values.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= values.length) return
      output[index] = await worker(values[index])
    }
  }))
  return output
}

function count(results: Result[], predicate: (result: Result) => boolean): number {
  return results.filter(predicate).length
}

async function main(): Promise<void> {
  console.error(`[legacy-price-reconcile] mode=${APPLY ? "apply" : "dry-run"} loading bounded candidate set`)
  const candidates = await loadCandidates()
  const bucketCounts = { B: count(candidates as Result[], r => r.bucket === "B"), C: count(candidates as Result[], r => r.bucket === "C"), D: count(candidates as Result[], r => r.bucket === "D") }
  const allowlistMode = ONLY_IDS.size > 0
  if (!allowlistMode && (bucketCounts.B !== 51 || bucketCounts.C !== 394 || bucketCounts.D !== 2 || candidates.length !== 447)) {
    throw new Error(`Scope mismatch: B=${bucketCounts.B} C=${bucketCounts.C} D=${bucketCounts.D} total=${candidates.length}; refusing to proceed`)
  }
  if (allowlistMode) {
    if (ONLY_IDS.size !== 12 || [...ONLY_IDS].some(id => !TECHNICAL_ALLOWLIST.has(id)) || !ONLY_IDS.has(20062) || !ONLY_IDS.has(9494) || [...ONLY_IDS].some(id => STORE_MISMATCH_IDS.has(id))) throw new Error("Immutable technical allowlist validation failed")
  }
  const scoped = ONLY_IDS.size > 0 ? candidates.filter(candidate => ONLY_IDS.has(candidate.catalogStateId)) : candidates
  const selected = scoped.slice(OFFSET, OFFSET + LIMIT)
  console.error(`[legacy-price-reconcile] scope B=${bucketCounts.B} C=${bucketCounts.C} D=${bucketCounts.D}; selected=${selected.length} offset=${OFFSET}; Trading concurrency=${CONCURRENCY}`)
  const results = await mapBounded(selected, processCandidate)
  const b0 = results.find(r => r.ebayItemId === "287597447567") ?? null
  const report = {
    mode: APPLY ? "apply" : "dry-run",
    dryRunCounts: bucketCounts,
    totalScope: candidates.length,
    selectedScope: selected.length,
    offset: OFFSET,
    remoteResultsForCD: {
      matched: count(results, r => (r.bucket === "C" || r.bucket === "D") && r.outcome === "MATCHED"),
      underTarget: count(results, r => (r.bucket === "C" || r.bucket === "D") && (r.outcome === "UNDER_TARGET" || r.outcome === "SUBMITTED")),
      aboveTarget: count(results, r => (r.bucket === "C" || r.bucket === "D") && r.outcome === "ABOVE_TARGET"),
      noCurrentPriceActionRequired: count(results, r => (r.bucket === "C" || r.bucket === "D") && r.outcome === "NO_CURRENT_PRICE_ACTION_REQUIRED"),
      inactive: count(results, r => (r.bucket === "C" || r.bucket === "D") && r.outcome === "INACTIVE"),
      remoteReadFailed: count(results, r => (r.bucket === "C" || r.bucket === "D") && r.outcome === "REMOTE_READ_FAILED"),
    },
    bResults: {
      submitted: count(results, r => r.bucket === "B" && r.outcome === "SUBMITTED"),
      skippedNoLongerNeeded: count(results, r => r.bucket === "B" && ["MATCHED", "ABOVE_TARGET", "NO_CURRENT_PRICE_ACTION_REQUIRED", "SKIPPED_DUPLICATE_OPERATION"].includes(r.outcome)),
      inactive: count(results, r => r.bucket === "B" && r.outcome === "INACTIVE"),
      failedToSubmit: count(results, r => r.bucket === "B" && (r.outcome === "FAILED_TO_SUBMIT" || r.outcome === "REMOTE_READ_FAILED")),
    },
    totalRepairOperationsSubmitted: count(results, r => r.outcome === "SUBMITTED"),
    b0,
    failureCount: count(results, r => r.outcome === "FAILED_TO_SUBMIT" || r.outcome === "REMOTE_READ_FAILED"),
    failureSamples: results
      .filter(r => r.outcome === "FAILED_TO_SUBMIT" || r.outcome === "REMOTE_READ_FAILED")
      .slice(0, 20)
      .map(r => ({ bucket: r.bucket, catalogStateId: r.catalogStateId, ebayItemId: r.ebayItemId, outcome: r.outcome, error: r.error })),
  }
  console.log(JSON.stringify(report, null, 2))
}

void main().then(() => db.end()).catch(async error => {
  console.error(error)
  await db.end().catch(() => undefined)
  process.exitCode = 1
})
