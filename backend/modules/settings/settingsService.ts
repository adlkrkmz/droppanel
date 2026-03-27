// ----------------------------------------------------------------
// settingsService.ts
// store_settings okuma/yazma + eBay Account API policy listesi.
// ----------------------------------------------------------------

import { getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import type { EbayMerchantLocationAddress } from "../ebay/ebayApiClient"
import { EbayApiClient } from "../ebay/ebayApiClient"
import { findStoreIdByCode } from "../publishQueue/publishQueueRepository"
import {
  createSettings,
  getSettingsByStore,
  updateSettings,
} from "../storeSettings/storeSettingsRepository"
import type { StoreAddress, StoreSettingsRow } from "../storeSettings/storeSettingsTypes"
import { query } from "../../db/client"

const EBAY_FULFILLMENT =
  "https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US"
const EBAY_PAYMENT =
  "https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_US"
const EBAY_RETURN =
  "https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_US"

export type EbayPolicyOption = {
  id:   string
  name: string
}

export type EbayPoliciesResponse = {
  fulfillmentPolicies: EbayPolicyOption[]
  paymentPolicies:     EbayPolicyOption[]
  returnPolicies:      EbayPolicyOption[]
}

export type SettingsForStoreResponse = {
  storeCode:             string
  storeName:             string
  markupPercent:         number
  countryOrRegion:       string | null
  cityState:             string | null
  address:               StoreAddress | null
  merchantLocationKey:   string | null
  registrationCountry:   string | null
  fulfillmentPolicyId:   string | null
  paymentPolicyId:       string | null
  returnPolicyId:        string | null
}

function rowToAddress(row: StoreSettingsRow): StoreAddress | null {
  const a1 = row.addressLine1?.trim()
  const city = row.addressCity?.trim()
  const state = row.addressState?.trim()
  const zip = row.addressZip?.trim()
  const country = row.addressCountry?.trim()
  if (!a1 || !city || !state || !zip || !country) return null
  return {
    firstName: row.addressFirstName?.trim() ?? "",
    lastName:  row.addressLastName?.trim()  ?? "",
    company:   row.addressCompany?.trim() || null,
    address1:  a1,
    address2:  row.addressLine2?.trim() || null,
    city,
    state,
    zip,
    country,
  }
}

function rowToSettingsResponse(
  store: { storeCode: string; name: string },
  row:   StoreSettingsRow | null
): SettingsForStoreResponse {
  const city = row?.addressCity?.trim() ?? ""
  const state = row?.addressState?.trim() ?? ""
  const cityState = [city, state].filter(Boolean).join(", ") || null
  return {
    storeCode:           store.storeCode,
    storeName:           store.name,
    markupPercent:       row?.markupPercent ?? 35,
    countryOrRegion:     row?.addressCountry?.trim() ?? null,
    cityState,
    address:             row ? rowToAddress(row) : null,
    merchantLocationKey:   row?.merchantLocationKey ?? null,
    registrationCountry:   row?.registrationCountry?.trim() ?? null,
    fulfillmentPolicyId: row?.fulfillmentPolicyId ?? null,
    paymentPolicyId:     row?.paymentPolicyId     ?? null,
    returnPolicyId:      row?.returnPolicyId      ?? null,
  }
}

export async function getSettingsForStore(
  workspaceId: string,
  storeCode:   string
): Promise<SettingsForStoreResponse | null> {
  const store = await findStoreIdByCode(workspaceId, storeCode)
  if (!store) return null
  const row = await getSettingsByStore(workspaceId, store.id)
  return rowToSettingsResponse(store, row)
}

export async function saveMarkup(
  workspaceId: string,
  storeCode: string,
  markupPercent: number
): Promise<void> {
  await query(
    `UPDATE store_settings
     SET markup_percent = $3,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND store_id = (
         SELECT id
         FROM stores
         WHERE workspace_id = $1
           AND store_code = $2
         LIMIT 1
       )`,
    [workspaceId, storeCode, markupPercent]
  )
}

/** eBay inventory location key: warehouse-{storeCode}, max 36 chars */
export function warehouseMerchantLocationKey(storeCode: string): string {
  const raw = storeCode.trim().replace(/[^a-zA-Z0-9_-]/g, "")
  const suffix = raw.slice(0, 26) || "store"
  const k = `warehouse-${suffix}`
  return k.length <= 36 ? k : k.slice(0, 36)
}

export type SaveAddressExtras = {
  registrationCountry?: string | null
}

export async function saveAddress(
  workspaceId: string,
  storeCode:   string,
  address:     StoreAddress,
  extras?:     SaveAddressExtras
): Promise<SettingsForStoreResponse | null> {
  const store = await findStoreIdByCode(workspaceId, storeCode)
  if (!store) return null

  const locKey = warehouseMerchantLocationKey(storeCode)
  const regTrim =
    extras?.registrationCountry !== undefined
      ? (extras.registrationCountry?.trim() || null)
      : undefined

  let row = await getSettingsByStore(workspaceId, store.id)
  const addrPatch: Parameters<typeof updateSettings>[2] = {
    addressFirstName: address.firstName.trim() || null,
    addressLastName:  address.lastName.trim()  || null,
    addressCompany:   address.company?.trim() || null,
    addressLine1:     address.address1.trim(),
    addressLine2:     address.address2?.trim() || null,
    addressCity:      address.city.trim(),
    addressState:     address.state.trim(),
    addressZip:       address.zip.trim(),
    addressCountry:   address.country.trim(),
    merchantLocationKey: locKey,
  }
  if (regTrim !== undefined) {
    addrPatch.registrationCountry = regTrim
  }

  if (!row) {
    row = await createSettings({
      workspaceId:         workspaceId,
      storeId:             store.id,
      merchantLocationKey: locKey,
      registrationCountry: regTrim ?? null,
      addressFirstName:    addrPatch.addressFirstName ?? null,
      addressLastName:     addrPatch.addressLastName  ?? null,
      addressCompany:      addrPatch.addressCompany   ?? null,
      addressLine1:        addrPatch.addressLine1     ?? null,
      addressLine2:        addrPatch.addressLine2     ?? null,
      addressCity:         addrPatch.addressCity      ?? null,
      addressState:        addrPatch.addressState     ?? null,
      addressZip:          addrPatch.addressZip       ?? null,
      addressCountry:      addrPatch.addressCountry   ?? null,
    })
  } else {
    const updated = await updateSettings(workspaceId, store.id, addrPatch)
    row = updated ?? row
  }
  return rowToSettingsResponse(store, row)
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

/** Adres kaydı sonrası eBay’de warehouse-{store} konumu oluştur (token yoksa log). */
export async function syncWarehouseMerchantLocationToEbay(
  workspaceId: string,
  storeCode:   string,
  address:     StoreAddress
): Promise<void> {
  try {
    const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
    const token   = await getValidAccessToken(workspaceId, storeCode, false)
    const client  = new EbayApiClient({
      oauthToken:     token,
      sandbox,
      simulationMode: false,
    })
    const key  = warehouseMerchantLocationKey(storeCode)
    const ebayAddr = storeAddressToEbayLocation(address)
    const res = await client.getMerchantLocation(key)
    if (res.kind === "not_found") {
      await client.createMerchantLocation(key, ebayAddr)
      console.log(`[Settings] eBay merchant location created: ${key}`)
    } else if (res.kind === "error") {
      console.warn(`[Settings] getMerchantLocation(${key}): ${res.message}`)
    }
  } catch (e) {
    console.warn(
      `[Settings] syncWarehouseMerchantLocationToEbay: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

function parseCityStateLine(line: string): { city: string; state: string } {
  const t = line.trim()
  const i = t.lastIndexOf(",")
  if (i <= 0) return { city: t, state: "" }
  return { city: t.slice(0, i).trim(), state: t.slice(i + 1).trim() }
}

export type SavePoliciesInput = {
  fulfillmentPolicyId?: string | null
  paymentPolicyId?:     string | null
  returnPolicyId?:      string | null
  countryOrRegion?:     string | null | undefined
  cityState?:           string | null | undefined
}

export async function savePolicies(
  workspaceId: string,
  storeCode:   string,
  input:       SavePoliciesInput
): Promise<SettingsForStoreResponse | null> {
  const store = await findStoreIdByCode(workspaceId, storeCode)
  if (!store) return null

  let row = await getSettingsByStore(workspaceId, store.id)

  const patch: Parameters<typeof updateSettings>[2] = {
    fulfillmentPolicyId: input.fulfillmentPolicyId ?? null,
    paymentPolicyId:     input.paymentPolicyId     ?? null,
    returnPolicyId:      input.returnPolicyId      ?? null,
  }

  if (input.countryOrRegion !== undefined) {
    patch.addressCountry =
      input.countryOrRegion === null || input.countryOrRegion === ""
        ? null
        : input.countryOrRegion
  }
  if (input.cityState !== undefined) {
    if (input.cityState === null || input.cityState === "") {
      patch.addressCity  = null
      patch.addressState = null
    } else {
      const { city, state } = parseCityStateLine(input.cityState)
      patch.addressCity  = city || null
      patch.addressState = state || null
    }
  }

  if (!row) {
    const cs =
      input.cityState !== undefined && input.cityState
        ? parseCityStateLine(input.cityState)
        : { city: null as string | null, state: null as string | null }
    row = await createSettings({
      workspaceId:         workspaceId,
      storeId:             store.id,
      fulfillmentPolicyId: input.fulfillmentPolicyId ?? null,
      paymentPolicyId:     input.paymentPolicyId     ?? null,
      returnPolicyId:      input.returnPolicyId      ?? null,
      addressCountry:
        input.countryOrRegion === undefined
          ? null
          : input.countryOrRegion === null || input.countryOrRegion === ""
            ? null
            : input.countryOrRegion,
      addressCity:  cs.city,
      addressState: cs.state,
    })
  } else {
    const updated = await updateSettings(workspaceId, store.id, patch)
    row = updated ?? row
  }

  return rowToSettingsResponse(store, row)
}

type RawFulfillment = { fulfillmentPolicyId?: string; name?: string }
type RawPayment     = { paymentPolicyId?: string; name?: string }
type RawReturn      = { returnPolicyId?: string; name?: string }

function mapFulfillment(p: RawFulfillment): EbayPolicyOption {
  return {
    id:   String(p.fulfillmentPolicyId ?? ""),
    name: String(p.name ?? ""),
  }
}

function mapPayment(p: RawPayment): EbayPolicyOption {
  return {
    id:   String(p.paymentPolicyId ?? ""),
    name: String(p.name ?? ""),
  }
}

function mapReturn(p: RawReturn): EbayPolicyOption {
  return {
    id:   String(p.returnPolicyId ?? ""),
    name: String(p.name ?? ""),
  }
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:        "application/json",
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`eBay Account API ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

export async function fetchEbayPolicies(
  workspaceId: string,
  storeCode:   string
): Promise<EbayPoliciesResponse> {
  const token = await getValidAccessToken(workspaceId, storeCode, false)

  type FulfillmentBody = { fulfillmentPolicies?: RawFulfillment[] }
  type PaymentBody     = { paymentPolicies?: RawPayment[] }
  type ReturnBody      = { returnPolicies?: RawReturn[] }

  const [fulfillmentBody, paymentBody, returnBody] = await Promise.all([
    fetchJson<FulfillmentBody>(EBAY_FULFILLMENT, token),
    fetchJson<PaymentBody>(EBAY_PAYMENT, token),
    fetchJson<ReturnBody>(EBAY_RETURN, token),
  ])

  const fulfillmentPolicies = (fulfillmentBody.fulfillmentPolicies ?? [])
    .map(mapFulfillment)
    .filter(p => p.id.length > 0)

  const paymentPolicies = (paymentBody.paymentPolicies ?? [])
    .map(mapPayment)
    .filter(p => p.id.length > 0)

  const returnPolicies = (returnBody.returnPolicies ?? [])
    .map(mapReturn)
    .filter(p => p.id.length > 0)

  return {
    fulfillmentPolicies,
    paymentPolicies,
    returnPolicies,
  }
}
