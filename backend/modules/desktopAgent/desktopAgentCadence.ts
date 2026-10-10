import { query } from "../../db/client"
import { loadGlobalKeepaFoundationConfig } from "../globalKeepa/globalKeepaConfig"
import { minRecheckHoursForPriority, nextSuccessCheckAt } from "../globalKeepa/globalKeepaCapacity"
import { markPlannerSuccess } from "../globalKeepa/globalKeepaPlannerState"
import type { ListingPriorityRank } from "../globalKeepa/globalKeepaTypes"

/**
 * Advance cloud next-check after a successful real Desktop observation.
 * Reuses Keepa planner cadence helpers; does not change SOLD/CLICKED/NORMAL hours.
 */
export async function advanceCloudCheckAfterDesktopSuccess(input: {
  globalAsinId: number
  catalogStateId: number
  priority: ListingPriorityRank
  checkedAt?: Date
}): Promise<{ nextCheckAt: string; cadenceHours: number }> {
  const checkedAt = input.checkedAt ?? new Date()
  const cfg = loadGlobalKeepaFoundationConfig()
  const cadenceHours = minRecheckHoursForPriority(input.priority, cfg)
  const nextCheckAt = nextSuccessCheckAt({
    lastSuccessAt: checkedAt,
    priority: input.priority,
    policy: cfg,
  })

  await query(
    `INSERT INTO global_keepa_planner_state (
       global_asin_id, priority, last_checked_at, last_success_at, next_check_at,
       failure_count, created_at, updated_at
     ) VALUES (
       $1::bigint, $2::smallint, $3::timestamptz, $3::timestamptz, $4::timestamptz,
       0, NOW(), NOW()
     )
     ON CONFLICT (global_asin_id) DO UPDATE SET
       priority = LEAST(COALESCE(global_keepa_planner_state.priority, EXCLUDED.priority), EXCLUDED.priority),
       last_checked_at = CASE
         WHEN global_keepa_planner_state.last_success_at IS NULL
           OR global_keepa_planner_state.last_success_at <= EXCLUDED.last_success_at
         THEN EXCLUDED.last_checked_at ELSE global_keepa_planner_state.last_checked_at END,
       last_success_at = CASE
         WHEN global_keepa_planner_state.last_success_at IS NULL
           OR global_keepa_planner_state.last_success_at <= EXCLUDED.last_success_at
         THEN EXCLUDED.last_success_at ELSE global_keepa_planner_state.last_success_at END,
       next_check_at = CASE
         WHEN global_keepa_planner_state.last_success_at IS NULL
           OR global_keepa_planner_state.last_success_at <= EXCLUDED.last_success_at
         THEN EXCLUDED.next_check_at ELSE global_keepa_planner_state.next_check_at END,
       failure_count = CASE
         WHEN global_keepa_planner_state.last_success_at IS NULL
           OR global_keepa_planner_state.last_success_at <= EXCLUDED.last_success_at
         THEN 0 ELSE global_keepa_planner_state.failure_count END,
       last_failure_code = CASE
         WHEN global_keepa_planner_state.last_success_at IS NULL
           OR global_keepa_planner_state.last_success_at <= EXCLUDED.last_success_at
         THEN NULL ELSE global_keepa_planner_state.last_failure_code END,
       claimed_until = CASE
         WHEN global_keepa_planner_state.last_success_at IS NULL
           OR global_keepa_planner_state.last_success_at <= EXCLUDED.last_success_at
         THEN NULL ELSE global_keepa_planner_state.claimed_until END,
       claimed_by = CASE
         WHEN global_keepa_planner_state.last_success_at IS NULL
           OR global_keepa_planner_state.last_success_at <= EXCLUDED.last_success_at
         THEN NULL ELSE global_keepa_planner_state.claimed_by END,
       updated_at = NOW()`,
    [input.globalAsinId, input.priority, checkedAt, nextCheckAt]
  )

  await markPlannerSuccess({
    globalAsinId: input.globalAsinId,
    nextCheckAt,
    checkedAt,
  }).catch(() => undefined)

  await query(
    `UPDATE store_catalog_state
     SET source_checked_at = $2::timestamptz,
         source_next_check_at = $3::timestamptz,
         updated_at = NOW()
     WHERE id = $1::bigint
       AND (source_checked_at IS NULL OR source_checked_at <= $2::timestamptz)`,
    [input.catalogStateId, checkedAt, nextCheckAt]
  ).catch(() => undefined)

  return { nextCheckAt: nextCheckAt.toISOString(), cadenceHours }
}
