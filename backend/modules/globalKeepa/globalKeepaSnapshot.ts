import type { GlobalKeepaPriceConfidence, GlobalKeepaRadarStatus } from "./globalKeepaTypes"

export type GlobalKeepaSnapshotFields = {
  newPrice: number | null
  newFbaCount: number | null
  newFbmCount: number | null
  keepaLastUpdate: Date | null
  keepaLastPriceChange: Date | null
  keepaLastUpdateMinutes: number | null
  keepaLastPriceChangeMinutes: number | null
  checkedAt: Date
  status: GlobalKeepaRadarStatus
  priceConfidence: GlobalKeepaPriceConfidence
}

export type GlobalKeepaSnapshotState = GlobalKeepaSnapshotFields & {
  previousNewPrice: number | null
  previousNewFbaCount: number | null
  previousNewFbmCount: number | null
  previousCheckedAt: Date | null
}

/** Latest-row snapshot: incoming current, previous = last current. */
export function nextKeepaSnapshotState(
  previous: GlobalKeepaSnapshotState | null,
  incoming: GlobalKeepaSnapshotFields
): GlobalKeepaSnapshotState {
  if (!previous) {
    return {
      ...incoming,
      previousNewPrice: null,
      previousNewFbaCount: null,
      previousNewFbmCount: null,
      previousCheckedAt: null,
    }
  }
  return {
    ...incoming,
    previousNewPrice: previous.newPrice,
    previousNewFbaCount: previous.newFbaCount,
    previousNewFbmCount: previous.newFbmCount,
    previousCheckedAt: previous.checkedAt,
  }
}

export const UPSERT_GLOBAL_KEEPA_SNAPSHOT_SQL = `
INSERT INTO global_keepa_snapshots (
  global_asin_id,
  new_price, new_fba_count, new_fbm_count,
  previous_new_price, previous_new_fba_count, previous_new_fbm_count,
  keepa_last_update, keepa_last_price_change,
  keepa_last_update_minutes, keepa_last_price_change_minutes,
  checked_at, previous_checked_at,
  status, price_confidence,
  created_at, updated_at
) VALUES (
  $1::bigint,
  $2::numeric, $3::integer, $4::integer,
  $5::numeric, $6::integer, $7::integer,
  $8::timestamptz, $9::timestamptz,
  $10::integer, $11::integer,
  $12::timestamptz, $13::timestamptz,
  $14::text, $15::text,
  NOW(), NOW()
)
ON CONFLICT (global_asin_id) DO UPDATE SET
  previous_new_price = global_keepa_snapshots.new_price,
  previous_new_fba_count = global_keepa_snapshots.new_fba_count,
  previous_new_fbm_count = global_keepa_snapshots.new_fbm_count,
  previous_checked_at = global_keepa_snapshots.checked_at,
  new_price = EXCLUDED.new_price,
  new_fba_count = EXCLUDED.new_fba_count,
  new_fbm_count = EXCLUDED.new_fbm_count,
  keepa_last_update = EXCLUDED.keepa_last_update,
  keepa_last_price_change = EXCLUDED.keepa_last_price_change,
  keepa_last_update_minutes = EXCLUDED.keepa_last_update_minutes,
  keepa_last_price_change_minutes = EXCLUDED.keepa_last_price_change_minutes,
  checked_at = EXCLUDED.checked_at,
  status = EXCLUDED.status,
  price_confidence = EXCLUDED.price_confidence,
  updated_at = NOW()
`

/** Failure / missing product: keep last successful current/previous price fields. */
export const MARK_GLOBAL_KEEPA_SNAPSHOT_FAILURE_SQL = `
INSERT INTO global_keepa_snapshots (
  global_asin_id,
  status, price_confidence,
  created_at, updated_at
) VALUES (
  $1::bigint,
  $2::text, $3::text,
  NOW(), NOW()
)
ON CONFLICT (global_asin_id) DO UPDATE SET
  status = EXCLUDED.status,
  price_confidence = EXCLUDED.price_confidence,
  updated_at = NOW()
`

export const UPDATE_KEEPA_SNAPSHOT_CANDIDATE_SQL = `
UPDATE global_keepa_snapshots
SET amazon_price = $2::numeric,
    candidate_price = $3::numeric,
    signal_class = $4,
    updated_at = NOW()
WHERE global_asin_id = $1::bigint
`

export async function persistKeepaSnapshotSuccess(
  globalAsinId: number,
  state: GlobalKeepaSnapshotState
): Promise<void> {
  const { query } = await import("../../db/client")
  await query(UPSERT_GLOBAL_KEEPA_SNAPSHOT_SQL, [
    globalAsinId,
    state.newPrice,
    state.newFbaCount,
    state.newFbmCount,
    state.previousNewPrice,
    state.previousNewFbaCount,
    state.previousNewFbmCount,
    state.keepaLastUpdate,
    state.keepaLastPriceChange,
    state.keepaLastUpdateMinutes,
    state.keepaLastPriceChangeMinutes,
    state.checkedAt,
    state.previousCheckedAt,
    state.status,
    state.priceConfidence,
  ])
}

export async function persistKeepaSnapshotCandidate(
  globalAsinId: number,
  input: { amazonPrice: number | null; candidatePrice: number | null; signalClass: string }
): Promise<void> {
  try {
    const { query } = await import("../../db/client")
    await query(UPDATE_KEEPA_SNAPSHOT_CANDIDATE_SQL, [
      globalAsinId,
      input.amazonPrice,
      input.candidatePrice,
      input.signalClass,
    ])
  } catch {
    /* column missing until migration 057 */
  }
}

export async function persistKeepaSnapshotFailure(
  globalAsinId: number,
  status: GlobalKeepaRadarStatus,
  priceConfidence: GlobalKeepaPriceConfidence
): Promise<void> {
  const { query } = await import("../../db/client")
  await query(MARK_GLOBAL_KEEPA_SNAPSHOT_FAILURE_SQL, [globalAsinId, status, priceConfidence])
}
