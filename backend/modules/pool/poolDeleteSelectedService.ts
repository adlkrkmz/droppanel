// ----------------------------------------------------------------
// poolDeleteSelectedService.ts — physical delete from asin_pool only
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { normalizePoolId } from "./poolEligibilityService"

const ACTIVE_PUBLISH_JOB_STATUSES = [
  "scheduled",
  "running",
  "queued",
  "waiting_for_capture",
] as const

const ACTIVE_PUBLISH_COMMAND_STATUSES = ["scheduled", "running"] as const

const ACTIVE_CAPTURE_ITEM_STATUSES = [
  "capture_pending",
  "capturing",
  "queued_for_publish",
] as const

const ACTIVE_CAPTURE_COMMAND_STATUSES = ["queued", "capturing", "publishing"] as const

const POOL_DELETE_MAX = 100

export type PoolDeleteSkippedItem = {
  poolId: number
  asin:   string | null
  reason: string
}

export type PoolDeleteSelectedResponse = {
  ok:           boolean
  deletedCount: number
  skippedCount: number
  skipped:      PoolDeleteSkippedItem[]
}

async function fetchActivePublishJobPoolIds(
  workspaceId: string,
  poolIds:     number[]
): Promise<Set<number>> {
  if (poolIds.length === 0) return new Set()

  const result = await query<{ pool_id: number }>(
    `SELECT DISTINCT spj.pool_id
     FROM scheduled_publish_jobs spj
     INNER JOIN scheduled_publish_commands spc ON spc.id = spj.command_id
     WHERE spj.workspace_id = $1
       AND spj.pool_id IS NOT NULL
       AND spj.pool_id = ANY($2::bigint[])
       AND spj.status = ANY($3::text[])
       AND spc.workspace_id = $1
       AND spc.status = ANY($4::text[])`,
    [
      workspaceId,
      poolIds,
      [...ACTIVE_PUBLISH_JOB_STATUSES],
      [...ACTIVE_PUBLISH_COMMAND_STATUSES],
    ]
  )

  return new Set(
    result.rows
      .map(r => normalizePoolId(r.pool_id))
      .filter((id): id is number => id != null)
  )
}

async function fetchActiveCapturePoolIds(
  workspaceId: string,
  poolIds:     number[]
): Promise<Set<number>> {
  if (poolIds.length === 0) return new Set()

  const result = await query<{ pool_id: number }>(
    `SELECT DISTINCT eci.pool_id
     FROM extension_capture_items eci
     INNER JOIN extension_capture_commands ecc ON ecc.id = eci.command_id
     WHERE eci.workspace_id = $1
       AND eci.pool_id IS NOT NULL
       AND eci.pool_id = ANY($2::bigint[])
       AND eci.status = ANY($3::text[])
       AND ecc.workspace_id = $1
       AND ecc.status = ANY($4::text[])`,
    [
      workspaceId,
      poolIds,
      [...ACTIVE_CAPTURE_ITEM_STATUSES],
      [...ACTIVE_CAPTURE_COMMAND_STATUSES],
    ]
  )

  return new Set(
    result.rows
      .map(r => normalizePoolId(r.pool_id))
      .filter((id): id is number => id != null)
  )
}

export async function deleteSelectedPoolItems(
  workspaceId: string,
  rawPoolIds:  number[]
): Promise<PoolDeleteSelectedResponse> {
  const poolIds = [...new Set(
    rawPoolIds.map(id => normalizePoolId(id)).filter((id): id is number => id != null)
  )]

  if (poolIds.length === 0) {
    return { ok: true, deletedCount: 0, skippedCount: 0, skipped: [] }
  }
  if (poolIds.length > POOL_DELETE_MAX) {
    throw new Error(`poolIds max ${POOL_DELETE_MAX} items`)
  }

  const rows = await query<{ id: unknown; asin: string | null }>(
    `SELECT ap.id, ar.asin
     FROM asin_pool ap
     LEFT JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.id = ANY($1::bigint[])
       AND ap.workspace_id = $2::uuid`,
    [poolIds, workspaceId]
  )

  const rowById = new Map<number, string | null>()
  for (const row of rows.rows) {
    const id = normalizePoolId(row.id)
    if (id != null) rowById.set(id, row.asin ?? null)
  }

  const activePublish = await fetchActivePublishJobPoolIds(workspaceId, poolIds)
  const activeCapture = await fetchActiveCapturePoolIds(workspaceId, poolIds)

  const skipped: PoolDeleteSkippedItem[] = []
  const toDelete: number[] = []
  const missingPoolIds: number[] = []
  const activeBlockedPoolIds: number[] = []

  for (const poolId of poolIds) {
    if (!rowById.has(poolId)) {
      missingPoolIds.push(poolId)
      skipped.push({ poolId, asin: null, reason: "POOL_NOT_FOUND" })
      continue
    }
    if (activePublish.has(poolId) || activeCapture.has(poolId)) {
      activeBlockedPoolIds.push(poolId)
      skipped.push({
        poolId,
        asin:   rowById.get(poolId) ?? null,
        reason: "ACTIVE_JOB_EXISTS",
      })
      continue
    }
    toDelete.push(poolId)
  }

  if (toDelete.length > 0) {
    await query(
      `DELETE FROM asin_pool
       WHERE workspace_id = $1::uuid
         AND id = ANY($2::bigint[])`,
      [workspaceId, toDelete]
    )
  }

  console.log("[PoolDeleteSelected]", {
    workspaceId,
    receivedPoolIds: poolIds,
    foundPoolIds:    [...rowById.keys()],
    missingPoolIds,
    activeBlockedPoolIds,
    deletablePoolIds: toDelete,
  })

  return {
    ok:           skipped.length === 0,
    deletedCount: toDelete.length,
    skippedCount: skipped.length,
    skipped,
  }
}
