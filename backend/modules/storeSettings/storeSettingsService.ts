// ─────────────────────────────────────────────────────────────
// storeSettingsService.ts
// ─────────────────────────────────────────────────────────────

import { query } from "../../db/client"
import {
  createSettings,
  getSettingsByStore,
  listSettingsForWorkspace,
  setEnabled,
  updateSettings,
} from "./storeSettingsRepository"
import type {
  CreateStoreSettingsInput,
  ResolvedStoreSettings,
  StoreSettingsRow,
  UpdateStoreSettingsInput,
  ValidationResult,
} from "./storeSettingsTypes"

// ─── VALIDATION ───────────────────────────────────────────────

export function validateSettings(
  input: Partial<CreateStoreSettingsInput>
): ValidationResult {
  const errors:   string[] = []
  const warnings: string[] = []

  // Margin
  if (input.profitMarginPercent !== undefined) {
    if (input.profitMarginPercent < 0) {
      errors.push("profitMarginPercent cannot be negative")
    } else if (input.profitMarginPercent > 200) {
      errors.push("profitMarginPercent cannot exceed 200%")
    } else if (input.profitMarginPercent < 5) {
      warnings.push("profitMarginPercent is very low (< 5%)")
    }
  }

  // Tax
  if (input.taxEstimatePercent !== undefined) {
    if (input.taxEstimatePercent < 0) {
      errors.push("taxEstimatePercent cannot be negative")
    } else if (input.taxEstimatePercent > 50) {
      errors.push("taxEstimatePercent exceeds 50% — likely incorrect")
    }
  }

  // eBay fee
  if (input.ebayFeePercent !== undefined) {
    if (input.ebayFeePercent < 0) {
      errors.push("ebayFeePercent cannot be negative")
    } else if (input.ebayFeePercent > 50) {
      errors.push("ebayFeePercent exceeds 50% — likely incorrect")
    } else if (input.ebayFeePercent < 5) {
      warnings.push("ebayFeePercent seems low — typical eBay fee is ~13%")
    }
  }

  // Quantity
  if (input.defaultQuantity !== undefined) {
    if (!Number.isInteger(input.defaultQuantity) || input.defaultQuantity < 1) {
      errors.push("defaultQuantity must be a positive integer")
    } else if (input.defaultQuantity > 999) {
      errors.push("defaultQuantity cannot exceed 999")
    }
  }

  // Interval
  if (input.intervalMinutes !== undefined) {
    if (input.intervalMinutes < 1) {
      errors.push("intervalMinutes must be at least 1")
    } else if (input.intervalMinutes < 5) {
      warnings.push("intervalMinutes is very low — may cause rate limiting")
    }
  }

  // Policy IDs — sadece dolu gelirse format kontrolü
  const policyFields: Array<[string, string | null | undefined]> = [
    ["paymentPolicyId",     input.paymentPolicyId],
    ["returnPolicyId",      input.returnPolicyId],
    ["fulfillmentPolicyId", input.fulfillmentPolicyId],
  ]
  for (const [field, val] of policyFields) {
    if (val !== undefined && val !== null && val.trim().length === 0) {
      errors.push(`${field} cannot be an empty string — use null to clear`)
    }
  }

  if (
    input.paymentPolicyId     !== undefined && !input.paymentPolicyId ||
    input.returnPolicyId      !== undefined && !input.returnPolicyId  ||
    input.fulfillmentPolicyId !== undefined && !input.fulfillmentPolicyId
  ) {
    warnings.push("One or more eBay policy IDs are missing — required for real publish")
  }

  return { valid: errors.length === 0, errors, warnings }
}

// ─── RESOLVE SETTINGS (with store meta) ───────────────────────

export async function resolveSettingsForStore(
  workspaceId: string,
  storeId:     number
): Promise<ResolvedStoreSettings | null> {
  const settings = await getSettingsByStore(workspaceId, storeId)
  if (!settings) return null

  const storeResult = await query<{ name: string; store_code: string }>(
    `SELECT name, store_code FROM stores WHERE id = $1 LIMIT 1`,
    [storeId]
  )
  const store = storeResult.rows[0]

  return {
    ...settings,
    storeName:  store?.name       ?? "Unknown",
    storeCode:  store?.store_code ?? "???",
  }
}

// ─── ALL SETTINGS FOR WORKSPACE ───────────────────────────────

export async function getAllStoreSettings(
  workspaceId: string
): Promise<ResolvedStoreSettings[]> {
  const rows = await listSettingsForWorkspace(workspaceId)
  if (rows.length === 0) return []

  const storeIds = rows.map(r => r.storeId)
  const storeResult = await query<{ id: number; name: string; store_code: string }>(
    `SELECT id, name, store_code FROM stores WHERE id = ANY($1::int[])`,
    [storeIds]
  )
  const storeMap = new Map(storeResult.rows.map(s => [s.id, s]))

  return rows.map(r => ({
    ...r,
    storeName: storeMap.get(r.storeId)?.name       ?? "Unknown",
    storeCode: storeMap.get(r.storeId)?.store_code ?? "???",
  }))
}

// ─── CREATE (with validation) ─────────────────────────────────

export async function createStoreSettings(
  input: CreateStoreSettingsInput
): Promise<{ settings: StoreSettingsRow; validation: ValidationResult }> {
  const validation = validateSettings(input)
  if (!validation.valid) {
    throw new Error(`Validation failed: ${validation.errors.join(" | ")}`)
  }

  // Zaten var mı?
  const existing = await getSettingsByStore(input.workspaceId, input.storeId)
  if (existing) {
    throw new Error(
      `Settings already exist for storeId=${input.storeId} — use updateStoreSettings()`
    )
  }

  const settings = await createSettings(input)
  return { settings, validation }
}

// ─── UPSERT (create or update) ────────────────────────────────

export async function upsertStoreSettings(
  input: CreateStoreSettingsInput
): Promise<{ settings: StoreSettingsRow; validation: ValidationResult; created: boolean }> {
  const validation = validateSettings(input)
  if (!validation.valid) {
    throw new Error(`Validation failed: ${validation.errors.join(" | ")}`)
  }

  const existing = await getSettingsByStore(input.workspaceId, input.storeId)

  if (existing) {
    const updated = await updateSettings(input.workspaceId, input.storeId, input)
    return { settings: updated!, validation, created: false }
  }

  const settings = await createSettings(input)
  return { settings, validation, created: true }
}

// ─── UPDATE (with validation) ─────────────────────────────────

export async function updateStoreSettings(
  workspaceId: string,
  storeId:     number,
  input:       UpdateStoreSettingsInput
): Promise<{ settings: StoreSettingsRow; validation: ValidationResult }> {
  const validation = validateSettings(input)
  if (!validation.valid) {
    throw new Error(`Validation failed: ${validation.errors.join(" | ")}`)
  }

  const settings = await updateSettings(workspaceId, storeId, input)
  if (!settings) {
    throw new Error(`No settings found for storeId=${storeId}`)
  }
  return { settings, validation }
}

// ─── ENABLE / DISABLE ─────────────────────────────────────────

export async function enableStore(
  workspaceId: string,
  storeId:     number
): Promise<StoreSettingsRow | null> {
  return setEnabled(workspaceId, storeId, true)
}

export async function disableStore(
  workspaceId: string,
  storeId:     number
): Promise<StoreSettingsRow | null> {
  return setEnabled(workspaceId, storeId, false)
}
