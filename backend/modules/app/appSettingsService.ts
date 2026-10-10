// ----------------------------------------------------------------
// appSettingsService.ts — user-scoped settings writes (Phase 3H)
// ----------------------------------------------------------------

import { insertAuditLog } from "../auth/authRepository"
import { getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import type { EbayMerchantLocationAddress } from "../ebay/ebayApiClient"
import { EbayApiClient } from "../ebay/ebayApiClient"
import { ensureWarehouseMerchantLocationOnEbay } from "../ebay/ebayLocationService"
import {
  getSettingsForStore,
  saveAddress,
  saveMarkup,
  savePricing,
  savePolicies,
  saveWarehouseBanner,
  warehouseMerchantLocationKey,
  type SavePoliciesInput,
  type SettingsForStoreResponse,
} from "../settings/settingsService"
import {
  createSettings,
  getSettingsByStore,
} from "../storeSettings/storeSettingsRepository"
import type { StoreAddress } from "../storeSettings/storeSettingsTypes"
import { isPricingMode, normalizeTieredProfitOverrides } from "../pricing/pricingService"
import type { PricingMode, TieredProfitOverrides } from "../pricing/pricingTypes"
import type { OwnedStore } from "./appOwnership"
import { AppHttpError } from "./appTypes"

async function writeSettingsAudit(
  actorUserId: string,
  action: string,
  store: OwnedStore,
  metadata: Record<string, unknown>
): Promise<void> {
  await insertAuditLog({
    actorUserId,
    action,
    targetType: "store",
    targetId:   store.storeCode,
    metadata:   { storeId: store.id, ...metadata },
  })
}

async function ensureSettingsRow(workspaceId: string, storeId: number): Promise<void> {
  const row = await getSettingsByStore(workspaceId, storeId)
  if (!row) {
    await createSettings({
      workspaceId,
      storeId,
      merchantLocationKey: null,
    })
  }
}

function storeAddressToEbayLocation(addr: StoreAddress): EbayMerchantLocationAddress {
  return {
    addressLine1:    addr.address1.trim(),
    city:            addr.city.trim(),
    stateOrProvince: addr.state.trim(),
    postalCode:      addr.zip.trim(),
    country:         addr.country.trim(),
  }
}

async function syncWarehouseLocationToEbay(
  workspaceId: string,
  storeCode:   string,
  address:     StoreAddress
): Promise<{ synced: boolean; error?: string }> {
  try {
    await getValidAccessToken(workspaceId, storeCode, false)
  } catch {
    return { synced: false, error: "eBay account not connected" }
  }

  try {
    const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
    const token   = await getValidAccessToken(workspaceId, storeCode, false)
    const client  = new EbayApiClient({
      oauthToken:     token,
      sandbox,
      simulationMode: false,
    })
    const ebayAddr = storeAddressToEbayLocation(address)
    await ensureWarehouseMerchantLocationOnEbay(client, storeCode, ebayAddr, { strict: false })
    return { synced: true }
  } catch (e) {
    console.warn(`[Settings] eBay location sync failed: ${e instanceof Error ? e.message : String(e)}`)
    return {
      synced: false,
      error:  "eBay location could not be synced",
    }
  }
}

export function parseMarkupPercent(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new AppHttpError(400, "markupPercent must be a number")
  }
  if (raw < 0 || raw > 300) {
    throw new AppHttpError(400, "markupPercent must be between 0 and 300")
  }
  return raw
}

export function parseWarehouseBannerEnabled(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw
  throw new AppHttpError(400, "warehouseShippingBannerEnabled must be a boolean")
}

function normalizePhysicalCountry(raw: string): string {
  const value = raw.trim()
  const upper = value.toUpperCase()
  const aliases: Record<string, string> = {
    "TURKEY": "TR",
    "TÜRKIYE": "TR",
    "TÜRKİYE": "TR",
    "UNITED STATES": "US",
    "UNITED STATES OF AMERICA": "US",
    "UNITED KINGDOM": "GB",
  }
  if (aliases[upper]) return aliases[upper]
  if (/^[A-Z]{2}$/.test(upper)) return upper
  throw new AppHttpError(400, "country must be a valid country code or country name")
}

export function parsePricingSettings(body: Record<string, unknown>): {
  pricingMode: PricingMode
  percentageNetProfitPercent: number
  tieredProfitOverrides: TieredProfitOverrides
} {
  const pricingMode = body.pricingMode
  if (!isPricingMode(pricingMode)) throw new AppHttpError(400, "Unsupported pricing mode")
  const percentage = Number(body.percentageNetProfitPercent)
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 1000) {
    throw new AppHttpError(400, "percentageNetProfitPercent must be between 0 and 1000")
  }
  try {
    return {
      pricingMode,
      percentageNetProfitPercent: percentage,
      tieredProfitOverrides: normalizeTieredProfitOverrides(body.tieredProfitOverrides),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid tiered profit overrides"
    throw new AppHttpError(400, msg)
  }
}

export function parseStoreAddress(body: Record<string, unknown>): StoreAddress {
  const nested = body.address
  const a = {
    ...((nested && typeof nested === "object" ? nested : {}) as Record<string, unknown>),
    ...body,
  }

  if (!String(a.address1 ?? "").trim()) throw new AppHttpError(400, "address1 is required")
  if (!String(a.city ?? "").trim())      throw new AppHttpError(400, "city is required")
  if (!String(a.state ?? "").trim())     throw new AppHttpError(400, "state is required")
  if (!String(a.zip ?? "").trim())       throw new AppHttpError(400, "zip is required")
  if (!String(a.country ?? "").trim())   throw new AppHttpError(400, "country is required")

  return {
    firstName: String(a.firstName ?? "").trim(),
    lastName:  String(a.lastName ?? "").trim(),
    company:   a.company ? String(a.company).trim() || null : null,
    address1:  String(a.address1).trim(),
    address2:  a.address2 ? String(a.address2).trim() || null : null,
    city:      String(a.city).trim(),
    state:     String(a.state).trim(),
    zip:       String(a.zip).trim(),
    country:   normalizePhysicalCountry(String(a.country)),
  }
}

export async function appSaveMarkup(input: {
  workspaceId:   string
  actorUserId:   string
  store:         OwnedStore
  markupPercent: number
}): Promise<{ ok: true; storeCode: string; markupPercent: number }> {
  const before = await getSettingsForStore(input.workspaceId, input.store.storeCode)
  await ensureSettingsRow(input.workspaceId, input.store.id)
  await saveMarkup(input.workspaceId, input.store.storeCode, input.markupPercent)

  await writeSettingsAudit(input.actorUserId, "app.settings.markup.update", input.store, {
    oldMarkupPercent: before?.markupPercent ?? null,
    newMarkupPercent: input.markupPercent,
  })

  return {
    ok:            true,
    storeCode:     input.store.storeCode,
    markupPercent: input.markupPercent,
  }
}

export async function appSavePricing(input: {
  workspaceId: string
  actorUserId: string
  store: OwnedStore
  pricingMode: PricingMode
  percentageNetProfitPercent: number
  tieredProfitOverrides: TieredProfitOverrides
}): Promise<SettingsForStoreResponse> {
  const result = await savePricing(input.workspaceId, input.store.storeCode, {
    pricingMode: input.pricingMode,
    percentageNetProfitPercent: input.percentageNetProfitPercent,
    tieredProfitOverrides: input.tieredProfitOverrides,
  })
  await writeSettingsAudit(input.actorUserId, "app.settings.pricing.update", input.store, {
    pricingMode: input.pricingMode,
    percentageNetProfitPercent: input.percentageNetProfitPercent,
  })
  return result
}

export async function appSaveAddress(input: {
  workspaceId:         string
  actorUserId:         string
  store:               OwnedStore
  address:             StoreAddress
  registrationCountry?: string | null
  countryOrRegion?:    string | null
  cityState?:          string | null
}): Promise<{
  ok: true
  storeCode: string
  addressSaved: boolean
  ebayLocationSynced: boolean
  ebayLocationSyncError?: string
  settings: SettingsForStoreResponse
}> {
  const before = await getSettingsForStore(input.workspaceId, input.store.storeCode)

  const result = await saveAddress(input.workspaceId, input.store.storeCode, input.address, {
    registrationCountry: input.registrationCountry?.trim() || null,
  })
  if (!result) throw new AppHttpError(404, "Store not found")

  const sync = await syncWarehouseLocationToEbay(
    input.workspaceId,
    input.store.storeCode,
    input.address
  )

  await writeSettingsAudit(input.actorUserId, "app.settings.address.update", input.store, {
    oldMerchantLocationKey: before?.merchantLocationKey ?? null,
    newMerchantLocationKey: warehouseMerchantLocationKey(input.store.storeCode),
    ebayLocationSynced:     sync.synced,
    ...(sync.error ? { ebayLocationSyncError: sync.error } : {}),
  })

  return {
    ok:                 true,
    storeCode:          input.store.storeCode,
    addressSaved:       true,
    ebayLocationSynced: sync.synced,
    ...(sync.error ? { ebayLocationSyncError: sync.error } : {}),
    settings:           result,
  }
}

export async function appSavePolicies(input: {
  workspaceId: string
  actorUserId: string
  store:       OwnedStore
  policies:    SavePoliciesInput
}): Promise<{
  ok: true
  storeCode: string
  fulfillmentPolicyId: string | null
  paymentPolicyId:     string | null
  returnPolicyId:      string | null
}> {
  const before = await getSettingsForStore(input.workspaceId, input.store.storeCode)
  const result = await savePolicies(input.workspaceId, input.store.storeCode, input.policies)
  if (!result) throw new AppHttpError(404, "Store not found")

  await writeSettingsAudit(input.actorUserId, "app.settings.policies.update", input.store, {
    oldFulfillmentPolicyId: before?.fulfillmentPolicyId ?? null,
    newFulfillmentPolicyId: result.fulfillmentPolicyId ?? null,
    oldPaymentPolicyId:     before?.paymentPolicyId ?? null,
    newPaymentPolicyId:     result.paymentPolicyId ?? null,
    oldReturnPolicyId:      before?.returnPolicyId ?? null,
    newReturnPolicyId:      result.returnPolicyId ?? null,
  })

  return {
    ok:                  true,
    storeCode:           input.store.storeCode,
    fulfillmentPolicyId: result.fulfillmentPolicyId ?? null,
    paymentPolicyId:     result.paymentPolicyId ?? null,
    returnPolicyId:      result.returnPolicyId ?? null,
  }
}

export async function appSaveWarehouseBanner(input: {
  workspaceId: string
  actorUserId: string
  store:       OwnedStore
  enabled:     boolean
}): Promise<{ ok: true; storeCode: string; warehouseShippingBannerEnabled: boolean }> {
  const before = await getSettingsForStore(input.workspaceId, input.store.storeCode)
  await saveWarehouseBanner(input.workspaceId, input.store.storeCode, input.enabled)

  await writeSettingsAudit(input.actorUserId, "app.settings.warehouse_banner.update", input.store, {
    oldEnabled: before?.warehouseShippingBannerEnabled ?? false,
    newEnabled: input.enabled,
  })

  return {
    ok:                           true,
    storeCode:                    input.store.storeCode,
    warehouseShippingBannerEnabled: input.enabled,
  }
}
