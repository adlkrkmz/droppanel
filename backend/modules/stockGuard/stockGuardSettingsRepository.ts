import { query } from "../../db/client"
import { listConnectedStores } from "./stockGuardActiveStores"
import type { StockGuardMode, StockGuardSettingsRow } from "./stockGuardTypes"

type DbRow = {
  id: number
  workspace_id: string
  store_id: number
  enabled: boolean
  mode: string
  price_alert_enabled: boolean
  price_increase_percent_threshold: string
  price_increase_amount_threshold: string
  sold_scan_hours: number
  clicked_scan_hours: number
  normal_scan_hours: number
  auto_zero_no_price_requires_repeat: boolean
  auto_profit_protection_enabled: boolean
}

function mapRow(r: DbRow): StockGuardSettingsRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    storeId: Number(r.store_id),
    // Kept for backward-compatible storage/API shape. Listing-level
    // stock_guard_enabled is now the only monitoring opt-out.
    enabled: true,
    mode: "auto" as StockGuardMode,
    priceAlertEnabled: true,
    priceIncreasePercentThreshold: parseFloat(r.price_increase_percent_threshold) || 10,
    priceIncreaseAmountThreshold: parseFloat(r.price_increase_amount_threshold) || 2,
    soldScanHours: r.sold_scan_hours,
    clickedScanHours: r.clicked_scan_hours,
    normalScanHours: r.normal_scan_hours,
    autoZeroNoPriceRequiresRepeat: r.auto_zero_no_price_requires_repeat,
    autoProfitProtectionEnabled: true,
  }
}

export async function ensureStockGuardSettings(
  workspaceId: string,
  storeId: number
): Promise<StockGuardSettingsRow> {
  await query(
    `INSERT INTO stock_guard_settings (workspace_id, store_id)
     VALUES ($1::uuid, $2::bigint)
     ON CONFLICT (workspace_id, store_id) DO NOTHING`,
    [workspaceId, storeId]
  )
  const existing = await getStockGuardSettings(workspaceId, storeId)
  if (existing) return existing
  throw new Error("Failed to ensure stock guard settings")
}

export async function getStockGuardSettings(
  workspaceId: string,
  storeId: number
): Promise<StockGuardSettingsRow | null> {
  try {
    const res = await query<DbRow>(
      `SELECT * FROM stock_guard_settings
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint LIMIT 1`,
      [workspaceId, storeId]
    )
    const row = res.rows[0]
    return row ? mapRow(row) : null
  } catch {
    return null
  }
}

export async function getStockGuardSettingsByStoreCode(
  workspaceId: string,
  storeCode: string
): Promise<(StockGuardSettingsRow & { storeCode: string; storeName: string }) | null> {
  const res = await query<DbRow & { store_code: string; name: string; sid: number }>(
    `SELECT sgs.*, s.id AS sid, s.store_code, s.name
     FROM stores s
     INNER JOIN ebay_accounts ea
       ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id
     LEFT JOIN stock_guard_settings sgs
       ON sgs.workspace_id = s.workspace_id AND sgs.store_id = s.id
     WHERE s.workspace_id = $1::uuid AND s.store_code = $2 AND s.status = 'active'
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  const row = res.rows[0]
  if (!row) return null
  const storeId = Number(row.sid)
  if (!row.id) {
    const ensured = await ensureStockGuardSettings(workspaceId, storeId)
    return { ...ensured, storeCode: row.store_code, storeName: row.name }
  }
  return { ...mapRow(row), storeCode: row.store_code, storeName: row.name }
}

export async function updateStockGuardSettings(
  workspaceId: string,
  storeId: number,
  patch: Partial<{
    enabled: boolean
    mode: StockGuardMode
    priceAlertEnabled: boolean
    priceIncreasePercentThreshold: number
    priceIncreaseAmountThreshold: number
    soldScanHours: number
    clickedScanHours: number
    normalScanHours: number
    autoZeroNoPriceRequiresRepeat: boolean
    autoProfitProtectionEnabled: boolean
  }>
): Promise<StockGuardSettingsRow> {
  await ensureStockGuardSettings(workspaceId, storeId)
  const res = await query<DbRow>(
    `UPDATE stock_guard_settings SET
       enabled = true,
       mode = 'auto',
       price_alert_enabled = true,
       price_increase_percent_threshold = COALESCE($6, price_increase_percent_threshold),
       price_increase_amount_threshold = COALESCE($7, price_increase_amount_threshold),
       sold_scan_hours = COALESCE($8, sold_scan_hours),
       clicked_scan_hours = COALESCE($9, clicked_scan_hours),
       normal_scan_hours = COALESCE($10, normal_scan_hours),
       auto_zero_no_price_requires_repeat = COALESCE($11, auto_zero_no_price_requires_repeat),
       auto_profit_protection_enabled = true,
       updated_at = NOW()
     WHERE workspace_id = $1::uuid AND store_id = $2::bigint
     RETURNING *`,
    [
      workspaceId,
      storeId,
      patch.enabled ?? null,
      patch.mode ?? null,
      patch.priceAlertEnabled ?? null,
      patch.priceIncreasePercentThreshold ?? null,
      patch.priceIncreaseAmountThreshold ?? null,
      patch.soldScanHours ?? null,
      patch.clickedScanHours ?? null,
      patch.normalScanHours ?? null,
      patch.autoZeroNoPriceRequiresRepeat ?? null,
      patch.autoProfitProtectionEnabled ?? null,
    ]
  )
  return mapRow(res.rows[0]!)
}

export async function listActiveStoresWithSettings(workspaceId: string): Promise<
  Array<{ storeId: number; storeCode: string; name: string; settings: StockGuardSettingsRow | null }>
> {
  const connected = await listConnectedStores(workspaceId)
  const out: Array<{ storeId: number; storeCode: string; name: string; settings: StockGuardSettingsRow | null }> = []
  for (const s of connected) {
    const settings = await getStockGuardSettings(workspaceId, s.storeId)
    out.push({
      storeId: s.storeId,
      storeCode: s.storeCode,
      name: s.name,
      settings,
    })
  }
  return out
}
