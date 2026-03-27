// ----------------------------------------------------------------
// storeSettingsRepository.ts
// ----------------------------------------------------------------

import { query } from "../../db/client"
import type {
  CreateStoreSettingsInput,
  StoreSettingsRow,
  UpdateStoreSettingsInput,
} from "./storeSettingsTypes"

function mapRow(r: Record<string, unknown>): StoreSettingsRow {
  return {
    id:                  r.id as number,
    workspaceId:         r.workspace_id as string,
    storeId:             r.store_id as number,
    markupPercent:       Number(r.markup_percent),
    profitMarginPercent: Number(r.profit_margin_percent),
    taxEstimatePercent:  Number(r.tax_estimate_percent),
    ebayFeePercent:      Number(r.ebay_fee_percent),
    defaultQuantity:     Number(r.default_quantity),
    templateId:          (r.template_id as string | null) ?? null,
    merchantLocationKey: (r.merchant_location_key as string | null) ?? null,
    paymentPolicyId:     (r.payment_policy_id as string | null) ?? null,
    returnPolicyId:      (r.return_policy_id as string | null) ?? null,
    fulfillmentPolicyId: (r.fulfillment_policy_id as string | null) ?? null,
    intervalMinutes:     Number(r.interval_minutes),
    enabled:             r.enabled as boolean,
    createdAt:           r.created_at as string,
    updatedAt:           r.updated_at as string,
    addressFirstName:    (r.address_first_name as string | null) ?? null,
    addressLastName:     (r.address_last_name as string | null) ?? null,
    addressCompany:      (r.address_company as string | null) ?? null,
    addressLine1:        (r.address_line1 as string | null) ?? null,
    addressLine2:        (r.address_line2 as string | null) ?? null,
    addressCity:         (r.address_city as string | null) ?? null,
    addressState:        (r.address_state as string | null) ?? null,
    addressZip:          (r.address_zip as string | null) ?? null,
    addressCountry:      (r.address_country as string | null) ?? null,
    registrationCountry: (r.registration_country as string | null) ?? null,
  }
}

export async function getSettingsByStore(
  workspaceId: string,
  storeId:     number
): Promise<StoreSettingsRow | null> {
  const result = await query(
    `SELECT *
     FROM store_settings
     WHERE workspace_id = $1
       AND store_id     = $2
     LIMIT 1`,
    [workspaceId, storeId]
  )
  const row = result.rows[0]
  return row ? mapRow(row as Record<string, unknown>) : null
}

export async function listSettingsForWorkspace(
  workspaceId: string
): Promise<StoreSettingsRow[]> {
  const result = await query(
    `SELECT *
     FROM store_settings
     WHERE workspace_id = $1
     ORDER BY store_id ASC`,
    [workspaceId]
  )
  return result.rows.map(r => mapRow(r as Record<string, unknown>))
}

export async function createSettings(
  input: CreateStoreSettingsInput
): Promise<StoreSettingsRow> {
  const result = await query(
    `INSERT INTO store_settings (
       workspace_id,
       store_id,
       markup_percent,
       profit_margin_percent,
       tax_estimate_percent,
       ebay_fee_percent,
       default_quantity,
       template_id,
       merchant_location_key,
       payment_policy_id,
       return_policy_id,
       fulfillment_policy_id,
       interval_minutes,
       enabled,
       address_first_name,
       address_last_name,
       address_company,
       address_line1,
       address_line2,
       address_city,
       address_state,
       address_zip,
       address_country,
       registration_country,
       created_at,
       updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW(),NOW())
     RETURNING *`,
    [
      input.workspaceId,
      input.storeId,
      input.markupPercent       ?? 35,
      input.profitMarginPercent ?? 20,
      input.taxEstimatePercent  ?? 0,
      input.ebayFeePercent      ?? 13,
      input.defaultQuantity     ?? 1,
      input.templateId          ?? null,
      input.merchantLocationKey ?? null,
      input.paymentPolicyId     ?? null,
      input.returnPolicyId      ?? null,
      input.fulfillmentPolicyId ?? null,
      input.intervalMinutes     ?? 30,
      input.enabled             ?? true,
      input.addressFirstName    ?? null,
      input.addressLastName     ?? null,
      input.addressCompany      ?? null,
      input.addressLine1        ?? null,
      input.addressLine2        ?? null,
      input.addressCity         ?? null,
      input.addressState        ?? null,
      input.addressZip          ?? null,
      input.addressCountry      ?? null,
      input.registrationCountry ?? null,
    ]
  )
  return mapRow(result.rows[0] as Record<string, unknown>)
}

export async function updateSettings(
  workspaceId: string,
  storeId:     number,
  input:       UpdateStoreSettingsInput
): Promise<StoreSettingsRow | null> {
  const fields: string[] = []
  const values: unknown[] = []
  let idx = 3

  function add(col: string, val: unknown): void {
    if (val === undefined) return
    fields.push(`${col} = $${idx}`)
    values.push(val)
    idx++
  }

  add("markup_percent",         input.markupPercent)
  add("profit_margin_percent",  input.profitMarginPercent)
  add("tax_estimate_percent",   input.taxEstimatePercent)
  add("ebay_fee_percent",       input.ebayFeePercent)
  add("default_quantity",       input.defaultQuantity)
  add("template_id",            input.templateId)
  add("merchant_location_key",  input.merchantLocationKey)
  add("payment_policy_id",      input.paymentPolicyId)
  add("return_policy_id",       input.returnPolicyId)
  add("fulfillment_policy_id",  input.fulfillmentPolicyId)
  add("interval_minutes",       input.intervalMinutes)
  add("enabled",                input.enabled)
  add("address_first_name",     input.addressFirstName)
  add("address_last_name",      input.addressLastName)
  add("address_company",        input.addressCompany)
  add("address_line1",          input.addressLine1)
  add("address_line2",          input.addressLine2)
  add("address_city",         input.addressCity)
  add("address_state",         input.addressState)
  add("address_zip",           input.addressZip)
  add("address_country",       input.addressCountry)
  add("registration_country",  input.registrationCountry)

  if (fields.length === 0) {
    return getSettingsByStore(workspaceId, storeId)
  }

  fields.push(`updated_at = NOW()`)

  const result = await query(
    `UPDATE store_settings
     SET ${fields.join(", ")}
     WHERE workspace_id = $1
       AND store_id     = $2
     RETURNING *`,
    [workspaceId, storeId, ...values]
  )

  const row = result.rows[0]
  return row ? mapRow(row as Record<string, unknown>) : null
}

export async function setEnabled(
  workspaceId: string,
  storeId:     number,
  enabled:     boolean
): Promise<StoreSettingsRow | null> {
  const result = await query(
    `UPDATE store_settings
     SET enabled    = $3,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND store_id     = $2
     RETURNING *`,
    [workspaceId, storeId, enabled]
  )
  const row = result.rows[0]
  return row ? mapRow(row as Record<string, unknown>) : null
}
