// ----------------------------------------------------------------
// appStockGuardSettingsService.ts — user-scoped Stock Guard settings (Phase 5E)
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { insertAuditLog } from "../auth/authRepository"
import { getLastCompletedAt } from "../stockGuard/stockGuardJobRepository"
import {
  ensureStockGuardSettings,
  updateStockGuardSettings,
} from "../stockGuard/stockGuardSettingsRepository"
import type { StockGuardMode, StockGuardSettingsRow } from "../stockGuard/stockGuardTypes"
import type { OwnedStore } from "./appOwnership"
import type {
  AppStockGuardSettings,
  AppStockGuardSettingsResponse,
  AppStockGuardSettingsUpdateResponse,
} from "./appTypes"
import { AppHttpError } from "./appTypes"

export type AppStockGuardSettingsInput = {
  enabled:                       boolean
  mode:                          StockGuardMode
  priceIncreaseAlertsEnabled:    boolean
  autoProfitProtectionEnabled:   boolean
}

async function getSettingsUpdatedAt(
  workspaceId: string,
  storeId:     number
): Promise<string | null> {
  try {
    const res = await query<{ updated_at: string | null }>(
      `SELECT updated_at::text AS updated_at
       FROM stock_guard_settings
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint
       LIMIT 1`,
      [workspaceId, storeId]
    )
    return res.rows[0]?.updated_at ?? null
  } catch {
    return null
  }
}

async function getLastRunStatus(
  workspaceId: string,
  storeId:     number
): Promise<string | null> {
  try {
    const res = await query<{ status: string }>(
      `SELECT status
       FROM stock_guard_scan_jobs
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint
       ORDER BY COALESCE(completed_at, started_at, created_at) DESC NULLS LAST
       LIMIT 1`,
      [workspaceId, storeId]
    )
    return res.rows[0]?.status?.trim() || null
  } catch {
    return null
  }
}

function toAppSettings(
  row: StockGuardSettingsRow,
  meta: {
    lastScanAt:    string | null
    lastRunStatus: string | null
    updatedAt:     string | null
  }
): AppStockGuardSettings {
  return {
    enabled:                     row.enabled,
    mode:                        row.mode,
    priceIncreaseAlertsEnabled:  row.priceAlertEnabled,
    autoProfitProtectionEnabled: row.autoProfitProtectionEnabled,
    lastScanAt:                  meta.lastScanAt,
    lastRunStatus:               meta.lastRunStatus,
    updatedAt:                   meta.updatedAt,
  }
}

function settingsSnapshot(settings: AppStockGuardSettings): Record<string, unknown> {
  return {
    enabled:                     settings.enabled,
    mode:                        settings.mode,
    priceIncreaseAlertsEnabled:  settings.priceIncreaseAlertsEnabled,
    autoProfitProtectionEnabled: settings.autoProfitProtectionEnabled,
  }
}

async function loadStoreSettings(
  workspaceId: string,
  store:       OwnedStore
): Promise<AppStockGuardSettings> {
  const row = await ensureStockGuardSettings(workspaceId, store.id)
  const [lastScanAt, lastRunStatus, updatedAt] = await Promise.all([
    getLastCompletedAt(workspaceId, store.id),
    getLastRunStatus(workspaceId, store.id),
    getSettingsUpdatedAt(workspaceId, store.id),
  ])
  return toAppSettings(row, { lastScanAt, lastRunStatus, updatedAt })
}

async function writeSettingsAudit(input: {
  actorUserId:      string
  success:          boolean
  workspaceId:      string
  store:            OwnedStore
  previousSettings?: AppStockGuardSettings
  newSettings?:     AppStockGuardSettings
  status?:          number
  reason?:          string
}): Promise<void> {
  try {
    await insertAuditLog({
      actorUserId: input.actorUserId,
      action: input.success
        ? "app.stock_guard.settings.update"
        : "app.stock_guard.settings.update.failed",
      targetType: "store",
      targetId:   input.store.storeCode,
      metadata: input.success
        ? {
            workspaceId:      input.workspaceId,
            storeCode:        input.store.storeCode,
            storeId:          input.store.id,
            actorUserId:      input.actorUserId,
            previousSettings: input.previousSettings
              ? settingsSnapshot(input.previousSettings)
              : null,
            newSettings: input.newSettings
              ? settingsSnapshot(input.newSettings)
              : null,
          }
        : {
            storeCode: input.store.storeCode,
            status:    input.status ?? 400,
            reason:    input.reason?.slice(0, 200) ?? "Settings update failed",
          },
    })
  } catch (e) {
    console.warn(
      "[App][stock-guard-settings] audit log failed:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

export function parseAppStockGuardMode(raw: unknown): StockGuardMode {
  const mode = String(raw ?? "").trim().toLowerCase()
  if (mode === "manual" || mode === "auto") return mode
  throw new AppHttpError(400, "mode must be manual or auto")
}

export function parseAppStockGuardBool(
  body: Record<string, unknown>,
  field: string
): boolean {
  const raw = body[field]
  if (typeof raw !== "boolean") {
    throw new AppHttpError(400, `${field} must be a boolean`)
  }
  return raw
}

export function validateAppStockGuardSettingsBody(
  body: Record<string, unknown>
): AppStockGuardSettingsInput {
  const enabled = parseAppStockGuardBool(body, "enabled")
  const mode = parseAppStockGuardMode(body.mode)
  const priceIncreaseAlertsEnabled = parseAppStockGuardBool(body, "priceIncreaseAlertsEnabled")
  const autoProfitProtectionEnabled = parseAppStockGuardBool(body, "autoProfitProtectionEnabled")
  const confirmationText = String(body.confirmationText ?? "")

  if (enabled === true && body.confirm !== true) {
    throw new AppHttpError(400, "confirm must be true")
  }

  if (
    enabled === true &&
    (mode === "auto" || autoProfitProtectionEnabled === true) &&
    confirmationText !== "AUTO"
  ) {
    throw new AppHttpError(400, 'confirmationText must be "AUTO"')
  }

  return {
    enabled,
    mode,
    priceIncreaseAlertsEnabled,
    autoProfitProtectionEnabled,
  }
}

export async function getAppStockGuardSettings(
  workspaceId: string,
  store:       OwnedStore
): Promise<AppStockGuardSettingsResponse> {
  const settings = await loadStoreSettings(workspaceId, store)
  return {
    ok:        true,
    storeCode: store.storeCode,
    settings,
  }
}

export async function updateAppStockGuardSettings(input: {
  workspaceId: string
  actorUserId: string
  store:       OwnedStore
  patch:       AppStockGuardSettingsInput
}): Promise<AppStockGuardSettingsUpdateResponse> {
  const previousSettings = await loadStoreSettings(input.workspaceId, input.store)

  try {
    await updateStockGuardSettings(input.workspaceId, input.store.id, {
      enabled:                     input.patch.enabled,
      mode:                        input.patch.mode,
      priceAlertEnabled:           input.patch.priceIncreaseAlertsEnabled,
      autoProfitProtectionEnabled: input.patch.autoProfitProtectionEnabled,
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    await writeSettingsAudit({
      actorUserId: input.actorUserId,
      success:     false,
      workspaceId: input.workspaceId,
      store:       input.store,
      status:      500,
      reason,
    })
    throw new AppHttpError(500, "Could not save Stock Guard settings")
  }

  const newSettings = await loadStoreSettings(input.workspaceId, input.store)

  await writeSettingsAudit({
    actorUserId:      input.actorUserId,
    success:          true,
    workspaceId:      input.workspaceId,
    store:            input.store,
    previousSettings,
    newSettings,
  })

  return {
    ok:        true,
    storeCode: input.store.storeCode,
    settings:  newSettings,
    message:   "Stock Guard settings saved.",
  }
}
