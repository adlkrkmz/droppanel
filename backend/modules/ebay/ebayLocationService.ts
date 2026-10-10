// ----------------------------------------------------------------
// ebayLocationService.ts
// eBay WAREHOUSE merchant location create/update (store_settings adresi).
// ----------------------------------------------------------------

import { warehouseMerchantLocationKey } from "../settings/settingsService"
import type { StoreSettingsRow } from "../storeSettings/storeSettingsTypes"
import type { EbayApiClient, EbayMerchantLocationAddress } from "./ebayApiClient"

export function merchantAddressFromStoreRow(row: StoreSettingsRow): EbayMerchantLocationAddress | null {
  const country = row.addressCountry?.trim()
  const city = row.addressCity?.trim()
  const state = row.addressState?.trim()
  const line1 = row.addressLine1?.trim()
  const zip = row.addressZip?.trim()
  if (!country || !city || !state || !line1 || !zip) return null
  return {
    addressLine1:    line1,
    city,
    stateOrProvince: state,
    postalCode:      zip,
    country,
  }
}

function normalizeAddr(a: EbayMerchantLocationAddress): EbayMerchantLocationAddress {
  return {
    addressLine1:    a.addressLine1.trim(),
    city:            a.city.trim(),
    stateOrProvince: a.stateOrProvince.trim(),
    postalCode:      a.postalCode.trim(),
    country:         a.country.trim().toUpperCase(),
  }
}

function addressesEqual(a: EbayMerchantLocationAddress, b: EbayMerchantLocationAddress): boolean {
  const left = normalizeAddr(a)
  const right = normalizeAddr(b)
  return (
    left.addressLine1.toLowerCase() === right.addressLine1.toLowerCase()
    && left.city.toLowerCase() === right.city.toLowerCase()
    && left.stateOrProvince.toLowerCase() === right.stateOrProvince.toLowerCase()
    && left.postalCode === right.postalCode
    && left.country === right.country
  )
}

function parseEbayLocationAddress(data: Record<string, unknown>): EbayMerchantLocationAddress | null {
  const loc = data.location as Record<string, unknown> | undefined
  const addr = (loc?.address ?? data.address) as Record<string, unknown> | undefined
  if (!addr) return null

  const line1 = String(addr.addressLine1 ?? "").trim()
  const city = String(addr.city ?? "").trim()
  const state = String(addr.stateOrProvince ?? "").trim()
  const zip = String(addr.postalCode ?? "").trim()
  const country = String(addr.country ?? "").trim()
  if (!line1 || !city || !state || !zip || !country) return null

  return {
    addressLine1:    line1,
    city,
    stateOrProvince: state,
    postalCode:      zip,
    country,
  }
}

export type EnsureWarehouseLocationOptions = {
  /** Publish path: throw on failure instead of continuing with stale eBay location. */
  strict?: boolean
}

export async function ensureWarehouseMerchantLocationOnEbay(
  client: EbayApiClient,
  storeCode: string,
  address: EbayMerchantLocationAddress,
  options: EnsureWarehouseLocationOptions = {}
): Promise<void> {
  const strict = options.strict === true
  const whKey = warehouseMerchantLocationKey(storeCode)
  const addr = normalizeAddr(address)

  console.log(
    `[eBayLocation] storeCode=${storeCode} merchantLocationKey=${whKey} addressZip=${addr.postalCode} city=${addr.city}`
  )

  const res = await client.getMerchantLocation(whKey)
  if (res.kind === "error") {
    const msg = `getMerchantLocation(${whKey}) failed: ${res.message}`
    console.error(`[eBayLocation] ${msg}`)
    if (strict) throw new Error(msg)
    return
  }

  if (res.kind === "not_found") {
    await client.createMerchantLocation(whKey, addr)
    console.log(
      `[eBayLocation] created inventory location storeCode=${storeCode} merchantLocationKey=${whKey}`
    )
    return
  }

  const existing = parseEbayLocationAddress(res.data)
  if (existing && addressesEqual(existing, addr)) {
    console.log(
      `[eBayLocation] inventory location up-to-date storeCode=${storeCode} merchantLocationKey=${whKey}`
    )
    return
  }

  await client.updateMerchantLocation(whKey, addr)
  console.log(
    `[eBayLocation] updated inventory location storeCode=${storeCode} merchantLocationKey=${whKey}`
  )
}

export function resolveMerchantLocationKey(
  storeCode: string,
  storeRow: StoreSettingsRow
): string {
  return storeRow.merchantLocationKey?.trim() || warehouseMerchantLocationKey(storeCode)
}
