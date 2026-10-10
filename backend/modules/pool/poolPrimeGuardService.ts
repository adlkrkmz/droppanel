// ----------------------------------------------------------------
// poolPrimeGuardService.ts — Prime guard (soft archive, job-aware)
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { sendTelegramAlert } from "../notifications/telegramService"
import { normalizePoolId } from "./poolEligibilityService"

export const NOT_PRIME_ARCHIVE_REASON   = "NOT_PRIME_SKIPPED"
export const OUT_OF_STOCK_ARCHIVE_REASON = "OUT_OF_STOCK_SKIPPED"
export const HIGH_RISK_ARCHIVE_REASON   = "EBAY_HIGH_RISK_ARCHIVED"

const ARCHIVE_REASON_BY_SKIP: Record<string, string> = {
  NOT_PRIME:       NOT_PRIME_ARCHIVE_REASON,
  OUT_OF_STOCK:    OUT_OF_STOCK_ARCHIVE_REASON,
  LIMITED_STOCK:   "LIMITED_STOCK_SKIPPED",
  STOCK_UNKNOWN:   "STOCK_UNKNOWN_SKIPPED",
  NO_VALID_PRICE:  "NO_VALID_PRICE_SKIPPED",
  PRIME_UNKNOWN:   "PRIME_UNKNOWN_SKIPPED",
}

const ACTIVE_JOB_STATUSES     = ["scheduled", "running"] as const
const ACTIVE_COMMAND_STATUSES = ["scheduled", "running", "paused"] as const

export type NonPrimePoolEntry = {
  poolId: number
  asin:   string
}

export type ProcessNonPrimeResult = {
  archivedPoolIds:     number[]
  skippedJobPoolIds:   number[]
  archivedOnlyPoolIds: number[]
}

export async function fetchPoolPrimeStatus(
  workspaceId: string,
  poolIds:     number[]
): Promise<Map<number, boolean | null>> {
  const ids = poolIds.map(id => normalizePoolId(id)).filter((id): id is number => id != null)
  const out = new Map<number, boolean | null>()
  if (ids.length === 0) return out

  const result = await query<{ pool_id: number; is_prime: boolean | null }>(
    `SELECT ap.id AS pool_id, (apc.attributes->>'isPrime')::boolean AS is_prime
     FROM asin_pool ap
     JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     LEFT JOIN amazon_product_cache apc ON apc.asin_registry_id = ar.id
     WHERE ap.workspace_id = $1 AND ap.id = ANY($2::bigint[])`,
    [workspaceId, ids]
  )

  for (const id of ids) out.set(id, null)
  for (const r of result.rows) {
    const poolId = normalizePoolId(r.pool_id)
    if (poolId != null) out.set(poolId, r.is_prime === true)
  }
  return out
}

export function isAmazonAsin(asin: string): boolean {
  return asin.startsWith("B") || /^[A-Z0-9]{10}$/.test(asin)
}

export async function fetchActiveScheduledJobsForPoolIds(
  workspaceId: string,
  poolIds:     number[]
): Promise<Map<number, Array<{ jobId: number; commandId: number; asin: string | null }>>> {
  const ids = poolIds.map(id => normalizePoolId(id)).filter((id): id is number => id != null)
  const out = new Map<number, Array<{ jobId: number; commandId: number; asin: string | null }>>()
  if (ids.length === 0) return out

  const result = await query<{
    pool_id:    number
    job_id:     number
    command_id: number
    asin:       string | null
  }>(
    `SELECT spj.pool_id, spj.id AS job_id, spj.command_id, spj.asin
     FROM scheduled_publish_jobs spj
     INNER JOIN scheduled_publish_commands spc ON spc.id = spj.command_id
     WHERE spj.workspace_id = $1
       AND spj.pool_id = ANY($2::bigint[])
       AND spj.status = ANY($3::text[])
       AND spc.status = ANY($4::text[])`,
    [workspaceId, ids, [...ACTIVE_JOB_STATUSES], [...ACTIVE_COMMAND_STATUSES]]
  )

  for (const r of result.rows) {
    const poolId = normalizePoolId(r.pool_id)
    if (poolId == null) continue
    const list = out.get(poolId) ?? []
    list.push({ jobId: r.job_id, commandId: r.command_id, asin: r.asin })
    out.set(poolId, list)
  }
  return out
}

export async function softArchivePoolItems(
  workspaceId: string,
  poolIds:     number[],
  reason:      string,
  archivedBy:  string = "prime_guard"
): Promise<number[]> {
  const ids = [...new Set(
    poolIds.map(id => normalizePoolId(id)).filter((id): id is number => id != null)
  )]
  if (ids.length === 0) return []

  const result = await query<{ id: number }>(
    `UPDATE asin_pool
     SET archived_at    = NOW(),
         archived_by    = $3,
         archive_reason = $4,
         status         = 'skipped',
         updated_at     = NOW()
     WHERE workspace_id = $1
       AND id = ANY($2::bigint[])
       AND archived_at IS NULL
     RETURNING id`,
    [workspaceId, ids, archivedBy, reason]
  )
  return result.rows
    .map(r => normalizePoolId(r.id))
    .filter((id): id is number => id != null)
}

export async function skipActiveScheduledJobsForPoolIds(
  workspaceId: string,
  poolIds:     number[],
  errorMessage = "NOT_PRIME"
): Promise<Array<{ jobId: number; poolId: number; commandId: number }>> {
  const ids = poolIds.map(id => normalizePoolId(id)).filter((id): id is number => id != null)
  if (ids.length === 0) return []

  const result = await query<{ job_id: number; pool_id: number; command_id: number }>(
    `UPDATE scheduled_publish_jobs spj
     SET status = 'skipped',
         error_message = $4::text,
         result = jsonb_build_object('skipped', true, 'reason', $4::text, 'live', true),
         updated_at = NOW()
     FROM scheduled_publish_commands spc
     WHERE spj.command_id = spc.id
       AND spj.workspace_id = $1
       AND spj.pool_id = ANY($2::bigint[])
       AND spj.status = ANY($3::text[])
       AND spc.status = ANY($5::text[])
     RETURNING spj.id AS job_id, spj.pool_id, spj.command_id`,
    [
      workspaceId,
      ids,
      [...ACTIVE_JOB_STATUSES],
      errorMessage,
      [...ACTIVE_COMMAND_STATUSES],
    ]
  )

  const commandIds = [...new Set(result.rows.map(r => r.command_id))]
  if (commandIds.length > 0) {
    const { finalizeCommandProgress } = await import("../scheduledPublish/scheduledPublishService")
    for (const commandId of commandIds) {
      await finalizeCommandProgress(workspaceId, commandId)
    }
  }

  return result.rows
    .map(r => ({
      jobId:     r.job_id,
      poolId:    normalizePoolId(r.pool_id) ?? 0,
      commandId: r.command_id,
    }))
    .filter(r => r.poolId > 0)
}

function telegramTitleForReason(reason: string, inJob: boolean): string {
  if (reason === "NOT_PRIME") {
    return inJob ? "Prime Değil — Job'da Skip Edildi" : "Prime Değil — Havuzdan Arşivlendi"
  }
  if (reason === "PRIME_UNKNOWN") {
    return inJob
      ? "Prime Doğrulanamadı — Job'da Skip Edildi"
      : "Prime Doğrulanamadı — Havuzdan Arşivlendi"
  }
  if (reason === "OUT_OF_STOCK") {
    return inJob ? "Stok Yok — Job'da Skip Edildi" : "Stok Yok — Havuzdan Arşivlendi"
  }
  if (reason === "LIMITED_STOCK") {
    return inJob ? "Sınırlı Stok — Job'da Skip Edildi" : "Sınırlı Stok — Havuzdan Arşivlendi"
  }
  if (reason === "STOCK_UNKNOWN") {
    return inJob ? "Stok Doğrulanamadı — Job'da Skip Edildi" : "Stok Doğrulanamadı — Havuzdan Arşivlendi"
  }
  if (reason === "NEEDS_AMAZON_VALIDATION") {
    return "Prime/Stok Bilgisi Okunamadı — Kontrol Gerekli"
  }
  return `Skip — ${reason}`
}

async function sendAvailabilityTelegram(
  reason:       string,
  jobSkipped:   Array<{ asin: string }>,
  archivedOnly: Array<{ asin: string }>
): Promise<void> {
  const sendBatch = async (items: Array<{ asin: string }>, inJob: boolean) => {
    if (items.length === 0) return
    const lines = items.map(e => e.asin).slice(0, 20)
    const more  = items.length - lines.length
    const body  = lines.join("\n")
    const suffix = more > 0 ? `\n+${more} more` : ""
    await sendTelegramAlert(
      `⚠️ ${telegramTitleForReason(reason, inJob)}\n${items.length} ASIN\n${body}${suffix}`
    )
  }
  await sendBatch(jobSkipped, true)
  await sendBatch(archivedOnly, false)
}

/** Archive + skip jobs for definitive NOT_PRIME / OUT_OF_STOCK / PRIME_UNKNOWN. */
export async function processAvailabilityArchiveSkip(
  workspaceId: string,
  entries:     Array<{ poolId: number; asin: string; reason: string }>,
  opts?:       { notify?: boolean; skipActiveJobs?: boolean }
): Promise<ProcessNonPrimeResult> {
  const notify         = opts?.notify !== false
  const skipActiveJobs = opts?.skipActiveJobs !== false

  const byReason = new Map<string, Map<number, string>>()
  for (const e of entries) {
    const poolId = normalizePoolId(e.poolId)
    if (poolId == null) continue
    if (!ARCHIVE_REASON_BY_SKIP[e.reason]) continue
    const map = byReason.get(e.reason) ?? new Map<number, string>()
    map.set(poolId, e.asin)
    byReason.set(e.reason, map)
  }

  const allPoolIds = [...new Set(entries.map(e => normalizePoolId(e.poolId)).filter((id): id is number => id != null))]
  if (allPoolIds.length === 0) {
    return { archivedPoolIds: [], skippedJobPoolIds: [], archivedOnlyPoolIds: [] }
  }

  const activeByPool = skipActiveJobs
    ? await fetchActiveScheduledJobsForPoolIds(workspaceId, allPoolIds)
    : new Map()

  const skippedJobPoolIds: number[] = []
  const archivedPoolIds: number[] = []

  if (skipActiveJobs) {
    const withActiveJobs = allPoolIds.filter(id => (activeByPool.get(id)?.length ?? 0) > 0)
    if (withActiveJobs.length > 0) {
      const primaryReason = entries[0]?.reason ?? "NOT_PRIME"
      await skipActiveScheduledJobsForPoolIds(workspaceId, withActiveJobs, primaryReason)
      skippedJobPoolIds.push(...withActiveJobs)
    }
  }

  for (const [reason, map] of byReason) {
    const archiveReason = ARCHIVE_REASON_BY_SKIP[reason] ?? reason
    const ids = [...map.keys()]
    const archived = await softArchivePoolItems(workspaceId, ids, archiveReason, "availability_guard")
    archivedPoolIds.push(...archived)
  }

  const archivedOnlyPoolIds = allPoolIds.filter(id => !skippedJobPoolIds.includes(id))

  if (notify) {
    for (const [reason, map] of byReason) {
      const asinById = map
      const jobSkippedAsins = skippedJobPoolIds
        .filter(id => asinById.has(id))
        .map(id => ({ asin: asinById.get(id) ?? String(id) }))
      const archivedAsins = archivedOnlyPoolIds
        .filter(id => asinById.has(id))
        .map(id => ({ asin: asinById.get(id) ?? String(id) }))
      await sendAvailabilityTelegram(reason, jobSkippedAsins, archivedAsins).catch(() => undefined)
    }
  }

  return { archivedPoolIds, skippedJobPoolIds, archivedOnlyPoolIds }
}

async function sendNonPrimeTelegram(
  jobSkipped: Array<{ asin: string }>,
  archivedOnly: Array<{ asin: string }>
): Promise<void> {
  await sendAvailabilityTelegram("NOT_PRIME", jobSkipped, archivedOnly)
}

export async function sendNeedsAmazonValidationTelegram(asins: string[]): Promise<void> {
  if (asins.length === 0) return
  const lines = asins.slice(0, 20)
  const more  = asins.length - lines.length
  await sendTelegramAlert(
    `⚠️ Prime/Stok Bilgisi Okunamadı — Kontrol Gerekli\n${asins.length} ASIN\n${lines.join("\n")}${more > 0 ? `\n+${more} more` : ""}`
  ).catch(() => undefined)
}

/** @deprecated Use processAvailabilityArchiveSkip with explicit NOT_PRIME evidence */
export async function processNonPrimePoolItems(
  workspaceId: string,
  entries:     NonPrimePoolEntry[],
  opts?:       { notify?: boolean; skipActiveJobs?: boolean }
): Promise<ProcessNonPrimeResult> {
  const notify         = opts?.notify !== false
  const skipActiveJobs = opts?.skipActiveJobs !== false

  const unique = new Map<number, string>()
  for (const e of entries) {
    const poolId = normalizePoolId(e.poolId)
    if (poolId == null) continue
    unique.set(poolId, e.asin)
  }
  const poolIds = [...unique.keys()]
  if (poolIds.length === 0) {
    return { archivedPoolIds: [], skippedJobPoolIds: [], archivedOnlyPoolIds: [] }
  }

  const activeByPool = skipActiveJobs
    ? await fetchActiveScheduledJobsForPoolIds(workspaceId, poolIds)
    : new Map()

  const skippedJobPoolIds: number[] = []
  const archivedOnlyPoolIds: number[] = []

  if (skipActiveJobs) {
    const withActiveJobs = poolIds.filter(id => (activeByPool.get(id)?.length ?? 0) > 0)
    if (withActiveJobs.length > 0) {
      await skipActiveScheduledJobsForPoolIds(workspaceId, withActiveJobs, "NOT_PRIME")
      skippedJobPoolIds.push(...withActiveJobs)
    }
  }

  const archivedPoolIds = await softArchivePoolItems(
    workspaceId,
    poolIds,
    NOT_PRIME_ARCHIVE_REASON,
    "prime_guard"
  )

  for (const poolId of poolIds) {
    if (!skippedJobPoolIds.includes(poolId)) archivedOnlyPoolIds.push(poolId)
  }

  if (notify) {
    const jobSkippedAsins = skippedJobPoolIds.map(id => ({ asin: unique.get(id) ?? String(id) }))
    const archivedAsins   = archivedOnlyPoolIds.map(id => ({ asin: unique.get(id) ?? String(id) }))
    await sendNonPrimeTelegram(jobSkippedAsins, archivedAsins).catch(() => undefined)
  }

  console.log("[PrimeGuard] non_prime_processed", {
    archived: archivedPoolIds.length,
    jobSkipped: skippedJobPoolIds.length,
    archivedOnly: archivedOnlyPoolIds.length,
  })

  return { archivedPoolIds, skippedJobPoolIds, archivedOnlyPoolIds }
}

export async function archivePoolItemForHighRisk(
  workspaceId: string,
  poolId:      number
): Promise<void> {
  const id = normalizePoolId(poolId)
  if (id == null) return
  await softArchivePoolItems(workspaceId, [id], HIGH_RISK_ARCHIVE_REASON, "publish_queue")
}
