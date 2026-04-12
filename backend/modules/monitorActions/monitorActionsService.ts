// ─────────────────────────────────────────────────────────────
// monitorActionsService.ts
//
// Monitor ekranı aksiyonları:
//   - updatePrice  → eBay fiyat güncelle
//   - updateStock  → eBay stok güncelle
//   - blind        → quantity=0 yap (listing gizle)
//
// simulationMode=true  → gerçek eBay çağrısı yok
// simulationMode=false → EbayApiClient ile gerçek API
// ─────────────────────────────────────────────────────────────

import { query }          from "../../db/client"
import { EbayApiClient }  from "../ebay/ebayApiClient"
import { getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import type {
  BlindRequest, BlindResponse,
  UpdatePriceRequest, UpdatePriceResponse,
  UpdateStockRequest, UpdateStockResponse,
} from "./monitorActionsTypes"

// ─── HELPERS ──────────────────────────────────────────────────

function parseSku(sku: string): { asin: string | null; storeCode: string | null } {
  // Format: DPB071251380S1 (alphanumeric, no dashes)
  // or legacy: DP-B071251380-S1
  const cleanSku = sku.replace(/-/g, "")
  const match = cleanSku.match(/^DP([A-Z0-9]{10,14})([A-Z0-9]+)$/)
  if (!match) return { asin: null, storeCode: null }
  return { asin: match[1], storeCode: match[2] }
}

async function getStoreByCode(
  workspaceId: string,
  storeCode:   string
): Promise<{ id: number; name: string } | null> {
  const result = await query<{ id: number; name: string }>(
    `SELECT id, name FROM stores
     WHERE workspace_id = $1 AND store_code = $2 AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  return result.rows[0] ?? null
}

async function updatePoolListing(
  workspaceId: string,
  asin:        string,
  updates:     { price?: number; quantity?: number; blinded?: boolean }
): Promise<void> {
  // Update listing_history if it exists
  if (updates.price !== undefined) {
    await query(
      `UPDATE listing_history
       SET ebay_price = $1, updated_at = NOW()
       WHERE workspace_id = $2
         AND asin_registry_id = (
           SELECT id FROM asin_registry
           WHERE workspace_id = $2 AND asin = $3
           LIMIT 1
         )`,
      [updates.price, workspaceId, asin]
    ).catch(() => {}) // listing_history may not have this column, ignore
  }

  // Update asin_pool stage if blinded
  if (updates.blinded) {
    await query(
      `UPDATE asin_pool ap
       SET pipeline_stage = 'blinded', updated_at = NOW()
       FROM asin_registry ar
       WHERE ar.id = ap.asin_registry_id
         AND ap.workspace_id = $1
         AND ar.asin = $2`,
      [workspaceId, asin]
    ).catch(() => {})
  }
}

// ─── UPDATE PRICE ─────────────────────────────────────────────

export async function updatePrice(
  workspaceId:    string,
  req:            UpdatePriceRequest,
  simulationMode: boolean,
  sandbox:        boolean
): Promise<UpdatePriceResponse> {
  if (req.newPrice <= 0) throw new Error("newPrice must be > 0")

  const store = await getStoreByCode(workspaceId, req.storeCode)
  if (!store) throw new Error(`Store not found: "${req.storeCode}"`)

  if (simulationMode) {
    console.log(`[MonitorActions][SIM] updatePrice sku=${req.sku} price=${req.newPrice}`)
    return {
      success:    true,
      simulation: true,
      sku:        req.sku,
      newPrice:   req.newPrice,
      message:    `[SIM] Price updated to $${req.newPrice.toFixed(2)}`,
    }
  }

  // Get valid token
  const token = await getValidAccessToken(workspaceId, req.storeCode, false)
  const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })

  // Get offer for this SKU then update price
  const offersPage = await client.getOffers(req.sku)
  const offer      = offersPage.offers?.[0]

  if (!offer?.offerId) {
    throw new Error(`No offer found for SKU: ${req.sku}`)
  }

  // Update offer price via eBay API
  const updateRes = await fetch(
    `${sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com"}/sell/inventory/v1/offer/${encodeURIComponent(offer.offerId)}`,
    {
      method:  "PUT",
      headers: {
        "Authorization":    `Bearer ${token}`,
        "Content-Type":     "application/json",
        "Accept-Language":  "en-US",
        "Content-Language": "en-US",
      },
      body: JSON.stringify({
        pricingSummary: {
          price: { value: req.newPrice.toFixed(2), currency: "USD" }
        }
      }),
    }
  )

  if (!updateRes.ok && updateRes.status !== 204) {
    const text = await updateRes.text()
    throw new Error(`updateOffer failed: HTTP ${updateRes.status} — ${text}`)
  }

  // Update DB
  const { asin } = parseSku(req.sku)
  if (asin) await updatePoolListing(workspaceId, asin, { price: req.newPrice })

  return {
    success:    true,
    simulation: false,
    sku:        req.sku,
    newPrice:   req.newPrice,
    message:    `Price updated to $${req.newPrice.toFixed(2)}`,
  }
}

// ─── UPDATE STOCK ─────────────────────────────────────────────

export async function updateStock(
  workspaceId:    string,
  req:            UpdateStockRequest,
  simulationMode: boolean,
  sandbox:        boolean
): Promise<UpdateStockResponse> {
  if (req.quantity < 0) throw new Error("quantity must be >= 0")

  const store = await getStoreByCode(workspaceId, req.storeCode)
  if (!store) throw new Error(`Store not found: "${req.storeCode}"`)

  if (simulationMode) {
    console.log(`[MonitorActions][SIM] updateStock sku=${req.sku} qty=${req.quantity}`)
    return {
      success:    true,
      simulation: true,
      sku:        req.sku,
      quantity:   req.quantity,
      message:    `[SIM] Stock updated to ${req.quantity}`,
    }
  }

  console.log(`[MonitorActions] updateStock(start) storeCode=${req.storeCode} sku=${req.sku} qty=${req.quantity} simulation=${simulationMode} sandbox=${sandbox}`)

  try {
    const token  = await getValidAccessToken(workspaceId, req.storeCode, false)
    console.log(`[MonitorActions] updateStock tokenPrefix=${token.slice(0, 20)}`)
    const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })

    console.log(`[MonitorActions] updateStock calling updateQuantity sku=${req.sku} qty=${req.quantity}`)
    await client.updateQuantity(req.sku, req.quantity)
    console.log(`[MonitorActions] updateStock completed updateQuantity sku=${req.sku} qty=${req.quantity}`)

    // Offer quantity'sini de güncelle
    const offerId = await client.getOfferId(req.sku)
    if (offerId) {
      await client.updateOfferQuantity(offerId, req.quantity)
      console.log(`[MonitorActions] updateStock offer updated offerId=${offerId} qty=${req.quantity}`)
    } else {
      console.warn(`[MonitorActions] updateStock offerId not found for sku=${req.sku}`)
    }

  } catch (e) {
    console.error("[MonitorActions] updateStock error:", e instanceof Error ? e.message : String(e))
    throw e
  }

  return {
    success:    true,
    simulation: false,
    sku:        req.sku,
    quantity:   req.quantity,
    message:    `Stock updated to ${req.quantity}`,
  }
}

// ─── BLIND ────────────────────────────────────────────────────

export async function blindListing(
  workspaceId:    string,
  req:            BlindRequest,
  simulationMode: boolean,
  sandbox:        boolean
): Promise<BlindResponse> {
  const store = await getStoreByCode(workspaceId, req.storeCode)
  if (!store) throw new Error(`Store not found: "${req.storeCode}"`)

  if (simulationMode) {
    console.log(`[MonitorActions][SIM] blind sku=${req.sku}`)

    const { asin } = parseSku(req.sku)
    if (asin) await updatePoolListing(workspaceId, asin, { blinded: true })

    return {
      success:    true,
      simulation: true,
      sku:        req.sku,
      message:    `[SIM] Listing blinded (qty=0)`,
    }
  }

  const token  = await getValidAccessToken(workspaceId, req.storeCode, false)
  const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })

  // Set quantity to 0 — listing hidden from search
  await client.updateQuantity(req.sku, 0)

  // Update DB
  const { asin } = parseSku(req.sku)
  if (asin) await updatePoolListing(workspaceId, asin, { blinded: true })

  return {
    success:    true,
    simulation: false,
    sku:        req.sku,
    message:    `Listing blinded — quantity set to 0`,
  }
}
