// ─────────────────────────────────────────────────────────────
// workerRepository.ts
//
// asin_locks tablosu gerçek kolonları:
//   id                 bigint
//   workspace_id       uuid
//   asin_registry_id   bigint
//   locked_by_store_id integer
//   lock_reason        USER-DEFINED (enum)
//   locked_at          timestamp
//   expires_at         timestamp
//   created_at         timestamp
//
// WorkerService lock'u store bazında değil worker bazında tutar.
// locked_by_store_id = NULL kullanılır (worker process lock'u).
// expires_at = locked_at + TTL ile stale lock tespiti yapılır.
// ─────────────────────────────────────────────────────────────

import { query } from "../../db/client"
import type { AcquireLockResult, WorkerStage } from "./workerTypes"

const LOCK_TTL_MINUTES = 10

// ─── LOCK AL ──────────────────────────────────────────────────

export async function acquireLock(
  asinRegistryId: number,
  stage:          WorkerStage,
  workspaceId:    string
): Promise<AcquireLockResult> {
  try {
    // Stale (süresi dolmuş) lock'ları temizle, sonra insert dene
    const result = await query<{ id: number }>(
      `WITH cleanup AS (
         DELETE FROM asin_locks
         WHERE asin_registry_id = $1
           AND workspace_id     = $2
           AND expires_at       < NOW()
       )
       INSERT INTO asin_locks (
         workspace_id,
         asin_registry_id,
         locked_at,
         expires_at
       )
       VALUES (
         $2,
         $1,
         NOW(),
         NOW() + INTERVAL '${LOCK_TTL_MINUTES} minutes'
       )
       ON CONFLICT (workspace_id, asin_registry_id)
       DO NOTHING
       RETURNING id`,
      [asinRegistryId, workspaceId]
    )

    const acquired = (result.rowCount ?? 0) > 0

    return {
      acquired,
      poolId: asinRegistryId,
      stage,
      reason: acquired ? undefined : "Lock already held"
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(
      `[Lock] acquireLock failed for asinRegistryId=${asinRegistryId}: ${message}`
    )
    // Tablo yoksa veya constraint sorunu — işi engelleme, devam et
    return { acquired: true, poolId: asinRegistryId, stage }
  }
}

// ─── LOCK BIRAK ───────────────────────────────────────────────

export async function releaseLock(
  asinRegistryId: number,
  workspaceId:    string
): Promise<void> {
  try {
    await query(
      `DELETE FROM asin_locks
       WHERE asin_registry_id = $1
         AND workspace_id     = $2`,
      [asinRegistryId, workspaceId]
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[Lock] releaseLock failed for asinRegistryId=${asinRegistryId}: ${message}`)
  }
}

// ─── TOPLU LOCK BIRAK (workspace bazında) ────────────────────
// Worker process kapanırken workspace'teki tüm lock'ları temizler

export async function releaseAllLocksForWorker(workspaceId: string): Promise<void> {
  try {
    const result = await query(
      `DELETE FROM asin_locks
       WHERE workspace_id = $1`,
      [workspaceId]
    )
    const count = result.rowCount ?? 0
    if (count > 0) {
      console.log(`[Lock] Released ${count} lock(s) for workspace=${workspaceId}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[Lock] releaseAllLocks failed for workspace=${workspaceId}: ${message}`)
  }
}

// ─── LOCK KONTROL ─────────────────────────────────────────────

export async function isLocked(
  asinRegistryId: number,
  workspaceId:    string
): Promise<boolean> {
  try {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM asin_locks
       WHERE asin_registry_id = $1
         AND workspace_id     = $2
         AND expires_at       > NOW()`,
      [asinRegistryId, workspaceId]
    )
    return parseInt(result.rows[0]?.count ?? "0", 10) > 0
  } catch {
    return false
  }
}
