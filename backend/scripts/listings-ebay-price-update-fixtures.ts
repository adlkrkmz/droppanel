import "dotenv/config"
import assert from "assert"
import fs from "fs"
import {
  runListingPriceUpdate,
  type ListingPriceUpdateEbayClient,
} from "../modules/listings/listingsEbayPriceService"
import { resolveEbayListingIdentity } from "../modules/ebay/ebayListingIdentityService"
import type { EbayActiveListingPriceRow, EbayOfferSummary, EbayTradingItemSnapshot } from "../modules/ebay/ebayApiClient"

type FakeOffer = {
  offerId: string
  sku: string
  listingId: string
  price: number
  qty: number
  status: string
  marketplaceId?: string
}

function rowFromOffer(o: FakeOffer): EbayActiveListingPriceRow {
  return {
    sku: o.sku,
    offerId: o.offerId,
    listingId: o.listingId,
    price: o.price,
    availableQuantity: o.qty,
    currency: "USD",
    marketplaceId: o.marketplaceId ?? "EBAY_US",
  }
}

function makeClient(init: {
  offers?: FakeOffer[]
  inventory?: Record<string, number | null>
  trading?: Record<string, EbayTradingItemSnapshot | null>
  failPriceUpdate?: boolean
  failReadbackPrice?: number
  applyThenThrow?: boolean
}): ListingPriceUpdateEbayClient & { priceMutations: number; tradingMutations: number } {
  const offers = [...(init.offers ?? [])]
  const inventory: Record<string, number | null> = { ...(init.inventory ?? {}) }
  const trading: Record<string, EbayTradingItemSnapshot | null> = { ...(init.trading ?? {}) }
  const client = {
    priceMutations: 0,
    tradingMutations: 0,
    async getOffers(sku?: string) {
      const list = sku ? offers.filter(o => o.sku === sku) : offers
      return {
        offers: list.map(o => ({
          sku: o.sku,
          offerId: o.offerId,
          status: o.status,
          listing: { listingId: o.listingId },
          pricingSummary: { price: { value: o.price.toFixed(2), currency: "USD" } },
          availableQuantity: o.qty,
          marketplaceId: o.marketplaceId ?? "EBAY_US",
        })) as EbayOfferSummary[],
        total: list.length,
        limit: 50,
        offset: 0,
      }
    },
    async getOfferById(offerId: string) {
      const o = offers.find(x => x.offerId === offerId)
      return o ? rowFromOffer(o) : null
    },
    async getInventoryItemOrNull(sku: string) {
      if (!(sku in inventory)) return null
      return {
        sku,
        availability: { shipToLocationAvailability: { quantity: inventory[sku] ?? 0 } },
      }
    },
    async getTradingItemSnapshot(itemId: string) {
      return trading[itemId] ?? null
    },
    async updateOfferPriceById(offerId: string, newPrice: number) {
      client.priceMutations++
      const o = offers.find(x => x.offerId === offerId)
      if (!o) throw new Error("offer missing")
      if (init.applyThenThrow) {
        o.price = newPrice
        throw new Error("eBay inventory timeout")
      }
      if (init.failPriceUpdate) throw new Error("eBay inventory HTTP 500")
      o.price = init.failReadbackPrice != null ? init.failReadbackPrice : newPrice
    },
    async updateLiveOfferPriceQuantity(input: { sku: string; offerId: string; price: number; quantity: number }) {
      client.priceMutations++
      if (init.failPriceUpdate) throw new Error("updateLiveOfferPriceQuantity retryable: HTTP 500")
      const o = offers.find(x => x.offerId === input.offerId)
      if (!o) throw new Error("offer missing")
      o.price = input.price
      const current = trading[o.listingId]
      if (current) current.currentPrice = init.failReadbackPrice != null ? init.failReadbackPrice : input.price
      else trading[o.listingId] = { itemId:o.listingId, sku:o.sku, listingStatus:"Active", startPrice:input.price, currentPrice:init.failReadbackPrice != null ? init.failReadbackPrice : input.price, quantity:o.qty, quantityAvailable:o.qty, hasVariations:false, sellerUserId:"s" }
    },
    async reviseFixedPriceItemPrice() {
      client.tradingMutations++
      return { warnings: [] }
    },
  }
  return client
}

async function expectThrow(fn: () => Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await fn()
    assert.fail("expected throw")
  } catch (e) {
    assert.match(e instanceof Error ? e.message : String(e), re)
  }
}

async function main(): Promise<void> {
  // 1. DB offer ID correct
  {
    const client = makeClient({
      inventory: { SKU1: 1 },
      offers: [{ offerId: "OFF1", sku: "SKU1", listingId: "111", price: 10, qty: 1, status: "PUBLISHED" }],
    })
    const r = await runListingPriceUpdate({
      client, sku: "SKU1", itemId: "111", offerIdFromDb: "OFF1", newPrice: 12.5,
    })
    assert.equal(r.method, "inventory")
    assert.equal(r.mutated, true)
    assert.equal(client.priceMutations, 1)
    assert.equal(r.readbackQty, 1)
  }

  // 2. DB offer empty, found by SKU
  {
    const client = makeClient({
      inventory: { SKU1: 1 },
      offers: [{ offerId: "OFF1", sku: "SKU1", listingId: "111", price: 10, qty: 1, status: "PUBLISHED" }],
    })
    const r = await runListingPriceUpdate({
      client, sku: "SKU1", itemId: "111", offerIdFromDb: "", newPrice: 12.5,
    })
    assert.equal(r.offerId, "OFF1")
    assert.equal(client.priceMutations, 1)
  }

  // 3. SKU lookup empty, listing ID unique via index
  {
    const client = makeClient({
      inventory: { OTHER: 1 },
      offers: [{ offerId: "OFFX", sku: "OTHER", listingId: "111", price: 10, qty: 1, status: "PUBLISHED" }],
    })
    const index = new Map<string, EbayActiveListingPriceRow[]>()
    index.set("111", [rowFromOffer({ offerId: "OFFX", sku: "OTHER", listingId: "111", price: 10, qty: 1, status: "PUBLISHED" })])
    const r = await runListingPriceUpdate({
      client, sku: "MISSING", itemId: "111", offerIdFromDb: "", newPrice: 12, listingIdIndex: index,
    })
    assert.equal(r.offerId, "OFFX")
    assert.equal(client.priceMutations, 1)
  }

  // 4. Ambiguous / wrong store → mutation 0
  {
    const amb = makeClient({
      inventory: { SKU1: 1 },
      offers: [
        { offerId: "A", sku: "SKU1", listingId: "111", price: 10, qty: 1, status: "PUBLISHED" },
        { offerId: "B", sku: "SKU1", listingId: "111", price: 10, qty: 1, status: "PUBLISHED" },
      ],
    })
    await expectThrow(
      () => runListingPriceUpdate({ client: amb, sku: "SKU1", itemId: "111", offerIdFromDb: "", newPrice: 12 }),
      /AMBIGUOUS/
    )
    assert.equal(amb.priceMutations, 0)
    const wrong = makeClient({
      inventory: { SKU1: 1 },
      offers: [{ offerId: "OFF1", sku: "SKU1", listingId: "999", price: 10, qty: 1, status: "PUBLISHED" }],
    })
    await expectThrow(
      () => runListingPriceUpdate({ client: wrong, sku: "SKU1", itemId: "111", offerIdFromDb: "OFF1", newPrice: 12 }),
      /STORE_MISMATCH/
    )
    assert.equal(wrong.priceMutations, 0)
  }

  // 5. Inventory-managed GetItem qty 0, inventory qty 1
  {
    const idn = await resolveEbayListingIdentity(makeClient({
      inventory: { SKU1: 1 },
      offers: [{ offerId: "OFF1", sku: "SKU1", listingId: "111", price: 10, qty: 1, status: "PUBLISHED" }],
      trading: {
        "111": {
          itemId: "111", sku: "SKU1", listingStatus: "Active", startPrice: 10, currentPrice: 10,
          quantity: 0, quantityAvailable: 0, hasVariations: false, sellerUserId: "s",
        },
      },
    }), { sku: "SKU1", itemId: "111", offerIdFromDb: "OFF1" })
    assert.equal(idn.status, "RESOLVED_INVENTORY")
    assert.equal(idn.canonicalQty, 1)
  }

  // 6. Mutation unknown but target already on eBay → no extra mutation
  {
    const client = makeClient({
      inventory: { SKU1: 1 },
      offers: [{ offerId: "OFF1", sku: "SKU1", listingId: "111", price: 10, qty: 1, status: "PUBLISHED" }],
      applyThenThrow: true,
      trading: { "111": { itemId:"111", sku:"SKU1", listingStatus:"Active", startPrice:12, currentPrice:12, quantity:1, quantityAvailable:1, hasVariations:false, sellerUserId:"s" } },
    })
    const r = await runListingPriceUpdate({ client, sku: "SKU1", itemId: "111", offerIdFromDb: "OFF1", newPrice: 12 })
    assert.equal(r.mutated, false)
    assert.equal(r.readbackPrice, 12)
    assert.equal(client.priceMutations, 0)
  }

  // 7. Readback mismatch → persistOffer not treated as price success (throws)
  {
    let persisted = 0
    const client = makeClient({
      inventory: { SKU1: 1 },
      offers: [{ offerId: "OFF1", sku: "SKU1", listingId: "111", price: 10, qty: 1, status: "PUBLISHED" }],
      failReadbackPrice: 10.01,
    })
    await expectThrow(
      () => runListingPriceUpdate({
        client, sku: "SKU1", itemId: "111", offerIdFromDb: "OFF1", newPrice: 12,
        persistOffer: async () => { persisted++ },
      }),
      /readback did not match/
    )
    assert.equal(client.priceMutations, 1)
    assert.equal(client.tradingMutations, 0)
  }

  // 8. Replay → second mutation 0
  {
    const client = makeClient({
      inventory: { SKU1: 1 },
      offers: [{ offerId: "OFF1", sku: "SKU1", listingId: "111", price: 10, qty: 1, status: "PUBLISHED" }],
    })
    await runListingPriceUpdate({ client, sku: "SKU1", itemId: "111", offerIdFromDb: "OFF1", newPrice: 12 })
    const second = await runListingPriceUpdate({ client, sku: "SKU1", itemId: "111", offerIdFromDb: "OFF1", newPrice: 12 })
    assert.equal(second.mutated, false)
    assert.equal(client.priceMutations, 1)
  }

  // 9. Automatic updates retain their no-decrease guard; explicit seller updates may decrease.
  {
    const automatic = makeClient({
      inventory: { SKU1: 1 },
      offers: [{ offerId: "OFF1", sku: "SKU1", listingId: "111", price: 12, qty: 1, status: "PUBLISHED" }],
    })
    await expectThrow(
      () => runListingPriceUpdate({ client: automatic, sku: "SKU1", itemId: "111", offerIdFromDb: "OFF1", newPrice: 10 }),
      /price decrease/
    )
    assert.equal(automatic.priceMutations, 0)

    const explicit = makeClient({
      inventory: { SKU1: 1 },
      offers: [{ offerId: "OFF1", sku: "SKU1", listingId: "111", price: 12, qty: 1, status: "PUBLISHED" }],
    })
    const result = await runListingPriceUpdate({
      client: explicit, sku: "SKU1", itemId: "111", offerIdFromDb: "OFF1", newPrice: 10,
      allowPriceDecrease: true,
    })
    assert.equal(result.readbackPrice, 10)
    assert.equal(explicit.priceMutations, 1)
  }

  // 10. Publish success persists offer id
  {
    const persist = fs.readFileSync("modules/ebay/ebayPublishPersistenceService.ts", "utf8")
    assert.match(persist, /PUBLISH_MISSING_OFFER_ID/)
    assert.match(persist, /ebay_offer_id/)
  }

  // 11. Normal sync exact match persists offer id
  {
    const sync = fs.readFileSync("modules/listings/listingsSyncService.ts", "utf8")
    assert.match(sync, /ebay_offer_id\s+=\s+COALESCE\(NULLIF\(trim\(\$12\), ''\), ebay_offer_id\)/)
    assert.doesNotMatch(sync, /overlayMissingOffersBySku/)
  }

  console.log("listings-ebay-price-update-fixtures: PASS")
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
