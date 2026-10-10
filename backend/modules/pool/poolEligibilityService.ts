// ----------------------------------------------------------------
// poolEligibilityService.ts — centralized publish/dispatch eligibility
// ----------------------------------------------------------------

import { query } from "../../db/client"

export type PoolEligibilitySkipReason =
  | "POOL_ITEM_ARCHIVED"
  | "POOL_ITEM_ARCHIVED_NOT_ELIGIBLE"
  | "POOL_ITEM_ALREADY_LISTED"
  | "POOL_ITEM_COMPLETED"
  | "POOL_ITEM_SUCCESS"
  | "POOL_ITEM_NOT_FOUND"
  | "POOL_ITEM_MISSING_OR_DELETED"
  | "POOL_ITEM_NOT_ELIGIBLE"
  | "NOT_PRIME"
  | "OUT_OF_STOCK"
  | "LIMITED_STOCK"
  | "NO_VALID_PRICE"
  | "NEEDS_AMAZON_VALIDATION"
  | "PRIME_UNKNOWN"
  | "STOCK_UNKNOWN"

export type PoolEligibilitySkipDetail = {
  poolId: number
  asin?:  string | null
  reason: PoolEligibilitySkipReason
  detail?: string | null
}

export type PoolEligibilityRow = {
  poolId:        number
  asin:          string | null
  archivedAt:    string | null
  archiveReason: string | null
  pipelineStage: string
  status:        string
  listingStatus: string
}

const NOT_PRIME_ARCHIVE_REASONS = new Set([
  "NOT_PRIME_SKIPPED",
  "PRIME_GUARD_ARCHIVED",
  "NOT_PRIME_REMOVED_FROM_ACTIVE_POOL",
])

const PRIME_UNKNOWN_ARCHIVE_REASONS = new Set([
  "PRIME_UNKNOWN_SKIPPED",
])

const OUT_OF_STOCK_ARCHIVE_REASONS = new Set([
  "OUT_OF_STOCK_SKIPPED",
])

const LIMITED_STOCK_ARCHIVE_REASONS = new Set([
  "LIMITED_STOCK_SKIPPED",
])

const STOCK_UNKNOWN_ARCHIVE_REASONS = new Set([
  "STOCK_UNKNOWN_SKIPPED",
])

export type PoolEligibilitySplit = {
  eligibleIds: number[]
  skipDetails: PoolEligibilitySkipDetail[]
}

const DISPATCH_PIPELINE_STAGES = new Set(["validated", "scraped", "ai_generated"])
const DISPATCH_STATUSES        = new Set(["ready", "skipped"])
const FINAL_LISTING_STATUSES   = new Set(["success", "completed", "listed"])

export function normalizePoolId(raw: unknown): number | null {
  if (raw == null) return null
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw)
  return Number.isFinite(n) ? n : null
}

export function toPoolIdSet(values: Iterable<unknown>): Set<number> {
  const out = new Set<number>()
  for (const v of values) {
    const id = normalizePoolId(v)
    if (id != null) out.add(id)
  }
  return out
}

/** SQL fragment: non-archived, not listed/completed/success */
export function buildPoolEligibilityWhere(alias = "ap"): string {
  return `${alias}.archived_at IS NULL
    AND ${alias}.pipeline_stage <> 'listed'
    AND ${alias}.status <> 'completed'
    AND ${alias}.listing_status <> 'success'`
}

export function resolvePoolIneligibilityReason(
  row: PoolEligibilityRow
): PoolEligibilitySkipReason | null {
  if (row.archivedAt) {
    if (row.archiveReason && NOT_PRIME_ARCHIVE_REASONS.has(row.archiveReason)) return "NOT_PRIME"
    if (row.archiveReason && PRIME_UNKNOWN_ARCHIVE_REASONS.has(row.archiveReason)) return "PRIME_UNKNOWN"
    if (row.archiveReason && OUT_OF_STOCK_ARCHIVE_REASONS.has(row.archiveReason)) return "OUT_OF_STOCK"
    if (row.archiveReason && LIMITED_STOCK_ARCHIVE_REASONS.has(row.archiveReason)) return "LIMITED_STOCK"
    if (row.archiveReason && STOCK_UNKNOWN_ARCHIVE_REASONS.has(row.archiveReason)) return "STOCK_UNKNOWN"
    return "POOL_ITEM_ARCHIVED_NOT_ELIGIBLE"
  }
  if (row.pipelineStage === "listed") return "POOL_ITEM_ALREADY_LISTED"
  if (row.status === "completed") return "POOL_ITEM_COMPLETED"
  if (FINAL_LISTING_STATUSES.has(row.listingStatus)) return "POOL_ITEM_SUCCESS"
  if (!DISPATCH_STATUSES.has(row.status)) return "POOL_ITEM_NOT_ELIGIBLE"
  if (!DISPATCH_PIPELINE_STAGES.has(row.pipelineStage)) return "POOL_ITEM_NOT_ELIGIBLE"
  return null
}

export function isPoolItemPublishEligible(row: PoolEligibilityRow): boolean {
  return resolvePoolIneligibilityReason(row) === null
}

export async function loadPoolItemsByIds(
  workspaceId: string,
  poolIds:     number[]
): Promise<Map<number, PoolEligibilityRow>> {
  const out = new Map<number, PoolEligibilityRow>()
  if (poolIds.length === 0) return out

  const result = await query<{
    pool_id:        number
    asin:           string | null
    archived_at:    string | null
    archive_reason: string | null
    pipeline_stage: string
    status:         string
    listing_status: string
  }>(
    `SELECT
       ap.id                     AS pool_id,
       ar.asin,
       ap.archived_at::text      AS archived_at,
       ap.archive_reason,
       ap.pipeline_stage::text   AS pipeline_stage,
       ap.status::text           AS status,
       ap.listing_status::text   AS listing_status
     FROM asin_pool ap
     LEFT JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id = $1
       AND ap.id = ANY($2::bigint[])`,
    [workspaceId, poolIds.map(id => normalizePoolId(id)).filter((id): id is number => id != null)]
  )

  for (const r of result.rows) {
    const poolId = normalizePoolId(r.pool_id)
    if (poolId == null) continue

    out.set(poolId, {
      poolId,
      asin:          r.asin,
      archivedAt:    r.archived_at,
      archiveReason: r.archive_reason,
      pipelineStage: r.pipeline_stage,
      status:        r.status,
      listingStatus: r.listing_status,
    })
  }
  return out
}

export async function splitEligiblePoolItems(
  workspaceId: string,
  poolIds:     number[]
): Promise<PoolEligibilitySplit> {
  const skipDetails: PoolEligibilitySkipDetail[] = []
  const eligibleIds: number[] = []

  if (poolIds.length === 0) {
    return { eligibleIds, skipDetails }
  }

  const rows = await loadPoolItemsByIds(workspaceId, poolIds)

  for (const rawId of poolIds) {
    const poolId = normalizePoolId(rawId)
    if (poolId == null) {
      skipDetails.push({ poolId: 0, reason: "POOL_ITEM_NOT_FOUND" })
      continue
    }
    const row = rows.get(poolId)
    if (!row) {
      skipDetails.push({ poolId, reason: "POOL_ITEM_NOT_FOUND" })
      continue
    }
    const reason = resolvePoolIneligibilityReason(row)
    if (reason) {
      skipDetails.push({
        poolId,
        asin:   row.asin,
        reason,
        detail: reason === "POOL_ITEM_NOT_ELIGIBLE"
          ? `stage=${row.pipelineStage} status=${row.status} listing=${row.listingStatus}`
          : null,
      })
      continue
    }
    eligibleIds.push(poolId)
  }

  return { eligibleIds, skipDetails }
}

/** Load pool row by ASIN when pool_id lookup fails (row must still exist in DB). */
export async function loadPoolItemByAsin(
  workspaceId: string,
  asin:        string
): Promise<PoolEligibilityRow | null> {
  const normalized = asin.trim().toUpperCase()
  if (!normalized) return null

  const result = await query<{
    pool_id:        number
    asin:           string | null
    archived_at:    string | null
    archive_reason: string | null
    pipeline_stage: string
    status:         string
    listing_status: string
  }>(
    `SELECT
       ap.id AS pool_id,
       ar.asin,
       ap.archived_at::text AS archived_at,
       ap.archive_reason,
       ap.pipeline_stage::text AS pipeline_stage,
       ap.status::text AS status,
       ap.listing_status::text AS listing_status
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id = $1 AND UPPER(ar.asin) = $2
     ORDER BY ap.id DESC
     LIMIT 1`,
    [workspaceId, normalized]
  )

  const r = result.rows[0]
  if (!r) return null
  const poolId = normalizePoolId(r.pool_id)
  if (poolId == null) return null

  return {
    poolId,
    asin:          r.asin,
    archivedAt:    r.archived_at,
    archiveReason: r.archive_reason,
    pipelineStage: r.pipeline_stage,
    status:        r.status,
    listingStatus: r.listing_status,
  }
}
