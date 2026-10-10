import { EbayApiClient } from "../ebay/ebayApiClient"
import { persistExactEbayOfferMappingUniqueLiveItem, resolveEbayListingIdentity } from "../ebay/ebayListingIdentityService"
import { recordEbayMutation } from "../ebay/ebayMutationAudit"
import {
  isQuantityMutationSourceEnabled,
  quantityMutationDisabledMessage,
  type QuantityMutationSource,
} from "../ebay/quantityMutationSource"
import { getValidAccessToken, getValidAccessTokenByStoreId } from "../ebayOAuth/ebayOAuthService"

export type ZeroEbayListingInput = {
  internalSku:  string | null
  ebayItemId:   string | null
  ebayOfferId:  string | null
}

export type ZeroEbayListingResult = {
  method: "inventory" | "trading"
}

export const QUANTITY_EBAY_TIMEOUT_MS = 15_000
export const QUANTITY_RECONCILE_TIMEOUT_MS = 8_000

export class QuantityOutcomeUncertainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "QuantityOutcomeUncertainError"
  }
}

class QuantityOperationTimeoutError extends Error {
  constructor(label: string) {
    super(label + " timed out after " + QUANTITY_EBAY_TIMEOUT_MS + "ms")
    this.name = "QuantityOperationTimeoutError"
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof QuantityOperationTimeoutError
}

async function withQuantityDeadline<T>(
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = QUANTITY_EBAY_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new QuantityOperationTimeoutError(label))
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readQuantityOnce(
  client: EbayApiClient,
  input: ZeroEbayListingInput
): Promise<number | null> {
  try {
    const identity = await resolveEbayListingIdentity(client, {
      sku: input.internalSku?.trim() ?? "",
      itemId: input.ebayItemId?.trim() ?? "",
      offerIdFromDb: input.ebayOfferId?.trim() ?? "",
    })
    if (identity.model === "INVENTORY_SINGLE_SKU" || identity.model === "INVENTORY_VARIATION") {
      return identity.inventoryQty
    }
    if (identity.status === "RESOLVED_TRADING_LEGACY") {
      return identity.canonicalQty
    }
    if (input.internalSku?.trim()) {
      const item = await withQuantityDeadline(
        "read-only inventory reconciliation",
        signal => client.getInventoryItem(input.internalSku!.trim(), signal),
        QUANTITY_RECONCILE_TIMEOUT_MS
      )
      return item.availability?.shipToLocationAvailability?.quantity ?? null
    }
  } catch {
    // A failed read-only reconciliation deliberately remains uncertain.
  }
  return null
}

async function runQuantityMutation<T>(input: {
  client: EbayApiClient
  listing: ZeroEbayListingInput
  quantity: number
  label: string
  mutate: (signal: AbortSignal) => Promise<void>
  verify: (signal: AbortSignal) => Promise<T>
  verifiedQuantity: (value: T) => number | null
}): Promise<void> {
  try {
    const verified = await withQuantityDeadline(input.label, async signal => {
      await input.mutate(signal)
      return input.verify(signal)
    })
    if (input.verifiedQuantity(verified) !== input.quantity) {
      throw new QuantityOutcomeUncertainError(
        "eBay " + input.label + " outcome uncertain: expected " + input.quantity + ", got " + (input.verifiedQuantity(verified) ?? "unavailable")
      )
    }
  } catch (error) {
    if (!isTimeoutError(error)) throw error
    const observed = await readQuantityOnce(input.client, input.listing)
    if (observed === input.quantity) return
    // Never retry a timed-out mutation. The caller preserves this as unknown.
    throw new QuantityOutcomeUncertainError(
      "eBay " + input.label + " timed out; read-only reconciliation was inconclusive (got " + (observed ?? "unavailable") + ", expected " + input.quantity + ")"
    )
  }
}

function isEbayAlreadyUnavailableForZero(message: string): boolean {
  const m = message.toLowerCase()
  return (
    /auction ended/.test(m) ||
    /item cannot be accessed/.test(m) ||
    /listing has been closed/.test(m) ||
    /this listing has been deleted/.test(m) ||
    /\bhas ended\b/.test(m)
  )
}

/**
 * Set eBay listing quantity to an arbitrary value (quantity-only update).
 * 1) Inventory API bulk_update_price_quantity (SKU + offer) — no description required.
 * 2) Trading ReviseFixedPriceItem by ItemID only when inventory path fails.
 *
 * This is the shared quantity-only path used by Set Qty 0 / Set Qty 1 so that
 * no full inventory-item (description/title/image) update is required.
 */
export async function setListingQuantityOnEbay(
  workspaceId: string,
  storeCode:   string,
  input:       ZeroEbayListingInput,
  quantity:    number,
  source:      QuantityMutationSource,
  sandbox:     boolean,
  storeId?:    number
): Promise<ZeroEbayListingResult> {
  if (!isQuantityMutationSourceEnabled(source)) {
    recordEbayMutation("quantity", "blocked")
    throw new Error(quantityMutationDisabledMessage(source))
  }

  const qty    = Math.max(0, Math.trunc(quantity))
  const sku    = input.internalSku?.trim() || ""
  const itemId = input.ebayItemId?.trim() || ""
  const offerIdFromDb = input.ebayOfferId?.trim() || ""

  console.log(
    `[StockAlerts][SetQty=${qty}] attempting store=${storeCode} sku=${sku || "(none)"} itemId=${itemId || "(none)"} offerId=${offerIdFromDb || "(none)"}`
  )

  if (!sku && !itemId) {
    throw new Error("Missing internal_sku and ebay_item_id — cannot update eBay quantity")
  }

  let token: string
  try {
    token = storeId != null && Number.isInteger(storeId) && storeId > 0
      ? await getValidAccessTokenByStoreId(workspaceId, storeId, false)
      : await getValidAccessToken(workspaceId, storeCode, false)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`eBay token unavailable: ${msg}`)
  }

  const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })
  const identity = await resolveEbayListingIdentity(client, {
    sku,
    itemId,
    offerIdFromDb,
  })
  if (identity.status === "AMBIGUOUS" || identity.status === "STORE_MISMATCH" || identity.status === "MARKETPLACE_MISMATCH") {
    throw new Error(`eBay offer identity ${identity.status} — refusing quantity mutation`)
  }
  const resolvedSku = identity.inventorySku || sku
  const resolvedOffer = identity.offerId || offerIdFromDb
  if (identity.status === "RESOLVED_INVENTORY" && identity.offerId && storeId && itemId) {
    await persistExactEbayOfferMappingUniqueLiveItem({
      workspaceId,
      storeId,
      ebayItemId: itemId,
      offerId: identity.offerId,
    }).catch(() => undefined)
  }
  if (
    identity.status === "RESOLVED_INVENTORY" &&
    identity.inventoryQty === qty
  ) {
    return { method: "inventory" }
  }

  let lastError: Error | undefined
  const failures: string[] = []

  if (identity.status === "RESOLVED_INVENTORY" && resolvedSku) {
    await runQuantityMutation({
      client,
      listing: { ...input, internalSku: resolvedSku, ebayOfferId: resolvedOffer },
      quantity: qty,
      label: "inventory quantity update sku=" + resolvedSku,
      mutate: signal => client.updateQuantity(resolvedSku, qty, resolvedOffer || undefined, signal),
      verify: signal => client.getInventoryItem(resolvedSku, signal),
      verifiedQuantity: item => item.availability?.shipToLocationAvailability?.quantity ?? null,
    })
    return { method: "inventory" }
  }

  if (identity.model === "INVENTORY_SINGLE_SKU" || identity.model === "INVENTORY_VARIATION") {
    throw new Error(
      `Inventory offer not found for SKU=${resolvedSku || sku}; refusing Trading quantity revise`
    )
  }

  if (identity.status === "RESOLVED_TRADING_LEGACY" && itemId) {
    if (identity.canonicalQty === qty) return { method: "trading" }
    try {
      await runQuantityMutation({
        client,
        listing: input,
        quantity: qty,
        label: "Trading quantity update itemId=" + itemId,
        mutate: signal => client.reviseFixedPriceItemQuantity(itemId, qty, signal),
        verify: signal => client.getItemQuantityAvailable(itemId, signal),
        verifiedQuantity: value => value,
      })
      return { method: "trading" }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      failures.push(`Trading ${lastError.message}`)
      if (qty === 0 && isEbayAlreadyUnavailableForZero(lastError.message)) {
        return { method: "trading" }
      }
      throw new Error(failures.join("; ") || lastError.message)
    }
  }

  throw new Error(failures.join("; ") || lastError?.message || "eBay quantity update failed (no path succeeded)")
}

/**
 * Set eBay listing quantity to 0. Thin wrapper kept for existing callers;
 * delegates to setListingQuantityOnEbay so behavior is identical.
 */
export async function zeroListingQuantityOnEbay(
  workspaceId: string,
  storeCode:   string,
  input:       ZeroEbayListingInput,
  sandbox:     boolean
): Promise<ZeroEbayListingResult> {
  return setListingQuantityOnEbay(
    workspaceId,
    storeCode,
    input,
    0,
    "automatic_zero",
    sandbox
  )
}

export async function readListingQuantityOnEbay(
  workspaceId: string,
  storeCode: string,
  input: ZeroEbayListingInput,
  sandbox: boolean,
  storeId?: number
): Promise<number | null> {
  let token: string
  try {
    token =
      storeId != null && Number.isInteger(storeId) && storeId > 0
        ? await getValidAccessTokenByStoreId(workspaceId, storeId, false)
        : await getValidAccessToken(workspaceId, storeCode, false)
  } catch {
    return null
  }
  const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })
  return readQuantityOnce(client, input)
}
