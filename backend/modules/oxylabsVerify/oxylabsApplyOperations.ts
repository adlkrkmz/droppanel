import crypto from "crypto"
import { db, query } from "../../db/client"
import { markApplyOutboxDone, markApplyOutboxRetry } from "../amazonScan/amazonScanJobQueue"

export const OXYLABS_APPLY_LEASE_MS = 120_000
export const OXYLABS_APPLY_PROVIDER = "OXYLABS_PRODUCT"

export type OxylabsApplyAction = "zero_stock" | "profit_protection"
export type OxylabsApplyOpStatus = "CLAIMED" | "APPLIED" | "RETRYABLE" | "FAILED" | "SKIPPED"

export type OxylabsApplyClaimKind = "WON" | "already_claimed" | "already_applied" | "failed_terminal"

export type OxylabsApplyOpRow = {
  operationKey: string
  jobId: number
  catalogStateId: number
  action: OxylabsApplyAction
  target: string
  status: OxylabsApplyOpStatus
  owner: string | null
  leaseUntil: Date | null
  attemptCount: number
  ebayMutateCount: number
  ebayReadbackCount: number
}

export function oxylabsMutationOperationKey(input: {
  provider: string
  jobId: number
  candidateId: number | null
  fingerprint: string
  action: OxylabsApplyAction
  target: string
  catalogStateId: number
}): string {
  return [
    input.provider,
    String(input.jobId),
    String(input.candidateId ?? 0),
    input.fingerprint,
    input.action,
    input.target,
    String(input.catalogStateId),
  ].join(":")
}

function mapOp(row: Record<string, unknown>): OxylabsApplyOpRow {
  return {
    operationKey: String(row.operation_key),
    jobId: Number(row.job_id),
    catalogStateId: Number(row.catalog_state_id),
    action: row.action as OxylabsApplyAction,
    target: String(row.target),
    status: row.status as OxylabsApplyOpStatus,
    owner: row.owner != null ? String(row.owner) : null,
    leaseUntil: row.lease_until ? new Date(String(row.lease_until)) : null,
    attemptCount: Number(row.attempt_count ?? 0),
    ebayMutateCount: Number(row.ebay_mutate_count ?? 0),
    ebayReadbackCount: Number(row.ebay_readback_count ?? 0),
  }
}

function leaseActive(leaseUntil: Date | null, now: Date): boolean {
  return Boolean(leaseUntil && leaseUntil.getTime() > now.getTime())
}

export async function claimOxylabsApplyOperation(input: {
  operationKey: string
  jobId: number
  catalogStateId: number
  action: OxylabsApplyAction
  target: string
  owner: string
  now?: Date
  leaseMs?: number
}): Promise<{ kind: OxylabsApplyClaimKind; recovery: boolean; row: OxylabsApplyOpRow | null }> {
  const now = input.now ?? new Date()
  const leaseMs = input.leaseMs ?? OXYLABS_APPLY_LEASE_MS
  const leaseUntil = new Date(now.getTime() + leaseMs)
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const inserted = await client.query(
      `INSERT INTO oxylabs_apply_operations (
         operation_key, job_id, catalog_state_id, action, target, status, owner, lease_until,
         attempt_count, created_at, updated_at
       ) VALUES ($1, $2::bigint, $3::bigint, $4, $5, 'CLAIMED', $6, $7::timestamptz, 1, NOW(), NOW())
       ON CONFLICT (operation_key) DO NOTHING
       RETURNING *`,
      [
        input.operationKey,
        input.jobId,
        input.catalogStateId,
        input.action,
        input.target,
        input.owner,
        leaseUntil.toISOString(),
      ]
    )
    if (inserted.rows[0]) {
      await client.query("COMMIT")
      return { kind: "WON", recovery: false, row: mapOp(inserted.rows[0] as Record<string, unknown>) }
    }
    const existing = await client.query(
      `SELECT * FROM oxylabs_apply_operations WHERE operation_key = $1 FOR UPDATE`,
      [input.operationKey]
    )
    const row = existing.rows[0] as Record<string, unknown> | undefined
    if (!row) {
      await client.query("ROLLBACK")
      return { kind: "already_claimed", recovery: false, row: null }
    }
    const mapped = mapOp(row)
    if (mapped.status === "APPLIED" || mapped.status === "SKIPPED") {
      await client.query("COMMIT")
      return { kind: "already_applied", recovery: false, row: mapped }
    }
    if (mapped.status === "FAILED") {
      await client.query("COMMIT")
      return { kind: "failed_terminal", recovery: false, row: mapped }
    }
    if (leaseActive(mapped.leaseUntil, now)) {
      await client.query("COMMIT")
      return { kind: "already_claimed", recovery: false, row: mapped }
    }
    const upd = await client.query(
      `UPDATE oxylabs_apply_operations
       SET status = 'CLAIMED',
           owner = $2,
           lease_until = $3::timestamptz,
           attempt_count = attempt_count + 1,
           updated_at = NOW()
       WHERE operation_key = $1
         AND status IN ('CLAIMED', 'RETRYABLE')
         AND (lease_until IS NULL OR lease_until <= $4::timestamptz)
       RETURNING *`,
      [input.operationKey, input.owner, leaseUntil.toISOString(), now.toISOString()]
    )
    if (!upd.rows[0]) {
      await client.query("COMMIT")
      return { kind: "already_claimed", recovery: false, row: mapped }
    }
    await client.query("COMMIT")
    return { kind: "WON", recovery: mapped.ebayMutateCount > 0, row: mapOp(upd.rows[0] as Record<string, unknown>) }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

export async function markOxylabsApplyOperation(input: {
  operationKey: string
  status: OxylabsApplyOpStatus
  lastError?: string | null
  bumpMutate?: boolean
  bumpReadback?: boolean
}): Promise<void> {
  await query(
    `UPDATE oxylabs_apply_operations
     SET status = $2,
         last_error = COALESCE($3, last_error),
         ebay_mutate_count = ebay_mutate_count + CASE WHEN $4 THEN 1 ELSE 0 END,
         ebay_readback_count = ebay_readback_count + CASE WHEN $5 THEN 1 ELSE 0 END,
         applied_at = CASE WHEN $2 = 'APPLIED' THEN NOW() ELSE applied_at END,
         lease_until = CASE
           WHEN $2 IN ('APPLIED', 'SKIPPED', 'FAILED') THEN NULL
           ELSE lease_until
         END,
         updated_at = NOW()
     WHERE operation_key = $1`,
    [
      input.operationKey,
      input.status,
      input.lastError != null ? String(input.lastError).slice(0, 400) : null,
      input.bumpMutate === true,
      input.bumpReadback === true,
    ]
  )
}

export async function getOxylabsApplyOperation(operationKey: string): Promise<OxylabsApplyOpRow | null> {
  const res = await query(`SELECT * FROM oxylabs_apply_operations WHERE operation_key = $1`, [operationKey])
  return res.rows[0] ? mapOp(res.rows[0] as Record<string, unknown>) : null
}

export type GuardedMutationResult = {
  skipped: string | null
  applied: boolean
  recovered: boolean
  ebayMutated: boolean
  ebayReadback: boolean
}

export type ZeroStockTelemetryState = {
  consecutiveSuccesses: number
  reservedSlots: number
  active: boolean
}

/**
 * The durable zero-stock streak is audit/telemetry only. Source policy, Stock
 * Guard, and guarded-operation idempotency remain the mutation authorities.
 */
export function zeroStockTelemetryAllowsMutation(_state: ZeroStockTelemetryState): true {
  return true
}

async function reserveZeroStockSlot(): Promise<void> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    await client.query(`INSERT INTO oxylabs_zero_stock_kill_switch (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING`)
    await client.query(`UPDATE oxylabs_zero_stock_kill_switch SET reserved_slots=reserved_slots+1, updated_at=NOW() WHERE singleton=TRUE`)
    await client.query("COMMIT")
  } catch (e) { await client.query("ROLLBACK").catch(()=>undefined); throw e } finally { client.release() }
}
async function settleZeroStockSlot(success: boolean): Promise<void> {
  const client = await db.connect()
  try { await client.query("BEGIN"); await client.query(`UPDATE oxylabs_zero_stock_kill_switch SET reserved_slots=GREATEST(0,reserved_slots-1), consecutive_successes=CASE WHEN $1 THEN consecutive_successes+1 ELSE consecutive_successes END, active=CASE WHEN $1 AND consecutive_successes+1>=10 THEN TRUE ELSE active END, triggered_at=CASE WHEN $1 AND consecutive_successes+1>=10 THEN COALESCE(triggered_at,NOW()) ELSE triggered_at END, updated_at=NOW() WHERE singleton=TRUE`,[success]); await client.query("COMMIT") } catch(e){await client.query("ROLLBACK").catch(()=>undefined);throw e} finally{client.release()}
}
export async function resetZeroStockKillSwitchOnValidSource(): Promise<void> { await query(`UPDATE oxylabs_zero_stock_kill_switch SET consecutive_successes=0, reserved_slots=0, active=FALSE, triggered_at=NULL, last_reset_at=NOW(), updated_at=NOW() WHERE singleton=TRUE`) }

export async function runOxylabsGuardedMutation(input: {
  operationKey: string
  jobId: number
  catalogStateId: number
  action: OxylabsApplyAction
  target: string
  owner: string
  now?: Date
  leaseMs?: number
  mutate: () => Promise<{ ok: boolean; ebayMutated: boolean; error?: string }>
  readback: () => Promise<{ matchesTarget: boolean; observed: string | null }>
}): Promise<GuardedMutationResult> {
  const claim = await claimOxylabsApplyOperation({
    operationKey: input.operationKey,
    jobId: input.jobId,
    catalogStateId: input.catalogStateId,
    action: input.action,
    target: input.target,
    owner: input.owner,
    now: input.now,
    leaseMs: input.leaseMs,
  })
  if (claim.kind === "already_applied") {
    return { skipped: "already_applied", applied: false, recovered: false, ebayMutated: false, ebayReadback: false }
  }
  if (claim.kind === "already_claimed") {
    return { skipped: "already_claimed", applied: false, recovered: false, ebayMutated: false, ebayReadback: false }
  }
  if (claim.kind === "failed_terminal") {
    return { skipped: "failed_terminal", applied: false, recovered: false, ebayMutated: false, ebayReadback: false }
  }
  const zeroReserved = input.action === "zero_stock"
  if (zeroReserved) await reserveZeroStockSlot()

  if (claim.recovery) {
    const seen = await input.readback()
    await markOxylabsApplyOperation({
      operationKey: input.operationKey,
      status: seen.matchesTarget ? "APPLIED" : "CLAIMED",
      bumpReadback: true,
    })
    if (seen.matchesTarget) {
      return { skipped: null, applied: true, recovered: true, ebayMutated: false, ebayReadback: true }
    }
  }

  await markOxylabsApplyOperation({
    operationKey: input.operationKey,
    status: "CLAIMED",
    bumpMutate: true,
  })
  try {
    const r = await input.mutate()
    if (r.ebayMutated && r.ok) {
      if (zeroReserved) await settleZeroStockSlot(true)
      await markOxylabsApplyOperation({
        operationKey: input.operationKey,
        status: "APPLIED",
      })
      return { skipped: null, applied: true, recovered: false, ebayMutated: true, ebayReadback: false }
    }
    if (!r.ok) {
      if (zeroReserved) await settleZeroStockSlot(false)
      await markOxylabsApplyOperation({
        operationKey: input.operationKey,
        status: "RETRYABLE",
        lastError: r.error ?? "MUTATE_FAILED",
      })
      return { skipped: "RETRYABLE", applied: false, recovered: false, ebayMutated: false, ebayReadback: false }
    }
    await markOxylabsApplyOperation({
      operationKey: input.operationKey,
      status: "SKIPPED",
      lastError: r.error ?? "NO_EBAY_MUTATION",
    })
    if (zeroReserved) await settleZeroStockSlot(false)
    return { skipped: r.error ?? "SKIPPED", applied: false, recovered: false, ebayMutated: false, ebayReadback: false }
  } catch (e) {
    if (zeroReserved) await settleZeroStockSlot(false)
    const msg = e instanceof Error ? e.message : String(e)
    await markOxylabsApplyOperation({
      operationKey: input.operationKey,
      status: "RETRYABLE",
      lastError: msg,
    })
    return { skipped: "RETRYABLE", applied: false, recovered: false, ebayMutated: false, ebayReadback: false }
  }
}

export async function claimOxylabsOutboxForJob(jobId: number): Promise<{
  kind: "WON" | "already_claimed" | "already_applied" | "missing"
  id: number | null
}> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const res = await client.query(
      `WITH picked AS (
         SELECT o.id
         FROM amazon_scan_apply_outbox o
         JOIN amazon_scan_jobs j ON j.id = o.job_id
         WHERE o.job_id = $1::bigint
           AND o.status = 'PENDING' AND o.available_at <= NOW()
           AND (o.locked_until IS NULL OR o.locked_until < NOW())
           AND j.kind IN ('OXYLABS_PRODUCT_PRIMARY','OXYLABS_PRODUCT_CONFIRM')
         FOR UPDATE OF o SKIP LOCKED
       )
       UPDATE amazon_scan_apply_outbox o
       SET locked_until = NOW() + interval '2 minutes', updated_at = NOW()
       FROM picked
       WHERE o.id = picked.id
       RETURNING o.id`,
      [jobId]
    )
    if (res.rows[0]) {
      await client.query("COMMIT")
      return { kind: "WON", id: Number(res.rows[0].id) }
    }
    const cur = await client.query(
      `SELECT o.id, o.status, o.locked_until
       FROM amazon_scan_apply_outbox o
       WHERE o.job_id = $1::bigint
       LIMIT 1`,
      [jobId]
    )
    await client.query("COMMIT")
    const row = cur.rows[0]
    if (!row) return { kind: "missing", id: null }
    if (String(row.status) === "DONE") return { kind: "already_applied", id: Number(row.id) }
    if (String(row.status) === "FAILED") return { kind: "already_applied", id: Number(row.id) }
    return { kind: "already_claimed", id: Number(row.id) }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

export async function runOwnedOxylabsApply(
  jobId: number,
  apply: (id: number) => Promise<{ applied: number; confirmQueued: boolean; skipped: string }>
): Promise<{ applied: number; confirmQueued: boolean; skipped: string; outboxId: number | null }> {
  const owned = await claimOxylabsOutboxForJob(jobId)
  if (owned.kind !== "WON") {
    return { applied: 0, confirmQueued: false, skipped: owned.kind, outboxId: owned.id }
  }
  try {
    const result = await apply(jobId)
    await markApplyOutboxDone(owned.id as number)
    return { ...result, outboxId: owned.id }
  } catch (e) {
    await markApplyOutboxRetry(owned.id as number, e instanceof Error ? e.message : String(e))
    throw e
  }
}

export function newOxylabsApplyOwner(role: "handler" | "processor" | "replay" | "test"): string {
  return `${role}:${process.pid}:${crypto.randomUUID()}`
}
