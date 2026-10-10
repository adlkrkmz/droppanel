import assert from "node:assert/strict"
import { runListingPriceUpdate, type ListingPriceUpdateEbayClient } from "../modules/listings/listingsEbayPriceService"

function client(input: { stale?: boolean; bulk25002?: boolean; variation?: boolean; bulk500?: boolean }) {
  let price = 10; let qty = 3; let bulk = 0; let revise = 0
  const c: ListingPriceUpdateEbayClient = {
    getOffers: async () => ({ total: 0, size: 0, limit: 0, href: "", offers: [] }),
    getOfferById: async () => ({ sku: "SKU", price, offerId: "O", listingId: "I", availableQuantity: qty, currency: "USD", offerStatus: "PUBLISHED" }),
    getInventoryItemOrNull: async () => ({ sku: "SKU", availability: { shipToLocationAvailability: { quantity: qty } } }),
    getTradingItemSnapshot: async () => ({ itemId: "I", sku: "SKU", listingStatus: "Active", currentPrice: price, startPrice: price, quantity: qty, quantityAvailable: qty, hasVariations: input.variation === true, sellerUserId: "seller" }),
    updateOfferPriceById: async () => undefined,
    reviseFixedPriceItemPrice: async (_id, p) => { revise++; price = p; return { warnings: [] } },
    updateLiveOfferPriceQuantity: async ({ price: p, quantity: q }) => { bulk++; if (input.bulk500) throw new Error("retryable: HTTP 500"); if (input.bulk25002) throw new Error("25002 duplicate listing"); qty = q; if (!input.stale) price = p },
  }
  return { c, counts: () => ({ bulk, revise, qty, price }) }
}
async function run(input: Parameters<typeof client>[0]) {
  const x = client(input)
  const result = await runListingPriceUpdate({ client: x.c, sku: "SKU", itemId: "I", offerIdFromDb: "O", newPrice: 15, listingLive: true })
  return { result, ...x.counts() }
}
void (async () => {
  const a = await run({}); assert.equal(a.revise, 0); assert.equal(a.result.readbackPrice, 15)
  const b = await run({ stale: true }); assert.equal(b.revise, 1); assert.equal(b.result.readbackPrice, 15)
  const d = await run({ bulk25002: true }); assert.equal(d.revise, 1); assert.equal(d.qty, 3); assert.equal(d.result.readbackPrice, 15)
  await assert.rejects(() => run({ stale: true, variation: true }), /readback did not match/)
  await assert.rejects(() => run({ bulk500: true }), /HTTP 500/)
  console.log("PRICE_FALLBACK_FIXTURES=5/5")
})().catch(error => { console.error(error); process.exitCode = 1 })
