import { query } from "../../db/client"
import type { AmazonEmailParse } from "./mailboxTypes"
import {
  cityNorm,
  firstNameNorm,
  identityGatesPass,
  scoreAmazonCandidate,
} from "./orderMatchIdentity"

export {
  cityNorm,
  firstNameNorm,
  identityGatesPass,
  scoreAmazonCandidate,
  IDENTITY_LOOKBACK_MS,
  IDENTITY_LOOKAHEAD_MS,
} from "./orderMatchIdentity"

export type MatchCandidate = {
  id: number
  ebayOrderId: string
  amazonOrderNumber: string | null
  buyerName: string | null
  city: string | null
  state: string | null
  asin: string | null
  quantity: number | null
  orderCreatedAt: string | null
}

export type MatchResult =
  | {
      ok: true
      orderPk: number
      storeId: number
      reason: "exact_amazon_number" | "unique_high_confidence" | "unique_name_city_state"
    }
  | { ok: false; reason: "no_candidates" | "ambiguous" | "weak_evidence"; candidateIds: number[] }

function destFromRaw(raw: unknown): {
  name: string | null
  city: string | null
  state: string | null
} {
  if (!raw || typeof raw !== "object") return { name: null, city: null, state: null }
  const order = raw as Record<string, unknown>
  const instructions = order["fulfillmentStartInstructions"]
  const first = Array.isArray(instructions) ? instructions[0] : undefined
  const shippingStep =
    first && typeof first === "object" ? (first as Record<string, unknown>)["shippingStep"] : undefined
  const shipTo =
    shippingStep && typeof shippingStep === "object"
      ? (shippingStep as Record<string, unknown>)["shipTo"]
      : undefined
  const shipToObj = shipTo && typeof shipTo === "object" ? (shipTo as Record<string, unknown>) : {}
  const contact =
    shipToObj["contactAddress"] && typeof shipToObj["contactAddress"] === "object"
      ? (shipToObj["contactAddress"] as Record<string, unknown>)
      : {}
  const name = typeof shipToObj["fullName"] === "string" ? shipToObj["fullName"] : null
  const city = typeof contact["city"] === "string" ? contact["city"] : null
  const state = typeof contact["stateOrProvince"] === "string" ? contact["stateOrProvince"] : null
  return { name, city, state }
}

export async function matchAmazonParseToEbayOrder(input: {
  workspaceId: string
  parsed: AmazonEmailParse
  receivedAt: Date | null
}): Promise<MatchResult> {
  const amazonNo = input.parsed.amazonOrderNumber?.trim() || null
  if (amazonNo) {
    const exact = await query<{ id: number; store_id: number }>(
      `SELECT id, store_id FROM ebay_orders
       WHERE workspace_id = $1::uuid
         AND amazon_order_number = $2
       LIMIT 2`,
      [input.workspaceId, amazonNo]
    )
    if (exact.rows.length === 1) {
      return {
        ok: true,
        orderPk: Number(exact.rows[0]!.id),
        storeId: Number(exact.rows[0]!.store_id),
        reason: "exact_amazon_number",
      }
    }
    if (exact.rows.length > 1) {
      return { ok: false, reason: "ambiguous", candidateIds: exact.rows.map(r => Number(r.id)) }
    }
  }

  const asin = input.parsed.asin?.trim().toUpperCase() || null
  const qty = input.parsed.quantity
  const city = cityNorm(input.parsed.destinationCity)
  const state = (input.parsed.destinationState ?? "").trim().toUpperCase()

  const rows = await query<{
    id: number
    store_id: number
    ebay_order_id: string
    amazon_order_number: string | null
    buyer_name: string | null
    asin: string | null
    quantity: number | null
    order_created_at: string | null
    raw_ebay_order_json: unknown
  }>(
    `SELECT o.id, o.store_id, o.ebay_order_id, o.amazon_order_number, o.buyer_name,
            o.order_created_at::text AS order_created_at, o.raw_ebay_order_json,
            i.asin, i.quantity
     FROM ebay_orders o
     LEFT JOIN LATERAL (
       SELECT asin, quantity
       FROM ebay_order_items it
       WHERE it.order_id = o.id
       ORDER BY it.id ASC
       LIMIT 1
     ) i ON true
     WHERE o.workspace_id = $1::uuid
       AND o.order_created_at >= NOW() - INTERVAL '21 days'`,
    [input.workspaceId]
  )

  const scored: { id: number; storeId: number; score: number }[] = []
  for (const r of rows.rows) {
    if (r.amazon_order_number && amazonNo && r.amazon_order_number !== amazonNo) continue
    const addr = destFromRaw(r.raw_ebay_order_json)
    const { pass, score } = scoreAmazonCandidate({
      parsedAsin: asin,
      parsedCity: city || null,
      parsedState: state || null,
      parsedQty: qty,
      candidateAsin: r.asin,
      candidateCity: addr.city,
      candidateState: addr.state,
      candidateQty: r.quantity,
    })
    if (!pass) continue
    scored.push({ id: Number(r.id), storeId: Number(r.store_id), score })
  }

  if (scored.length === 1) {
    return {
      ok: true,
      orderPk: scored[0]!.id,
      storeId: scored[0]!.storeId,
      reason: "unique_high_confidence",
    }
  }
  if (scored.length > 1) {
    return { ok: false, reason: "ambiguous", candidateIds: scored.map(s => s.id) }
  }

  if (input.parsed.type === "AMAZON_ORDERED") {
    const identity = matchOrderedIdentity({
      workspaceId: input.workspaceId,
      parsed: input.parsed,
      receivedAt: input.receivedAt,
      rows: rows.rows,
    })
    if (identity.ok && amazonNo) {
      const dup = await query<{ id: number }>(
        `SELECT id FROM ebay_orders
         WHERE workspace_id = $1::uuid
           AND amazon_order_number = $2
           AND id <> $3
         LIMIT 1`,
        [input.workspaceId, amazonNo, identity.orderPk]
      )
      if (dup.rows[0]) {
        return { ok: false, reason: "weak_evidence", candidateIds: [identity.orderPk, Number(dup.rows[0].id)] }
      }
    }
    return identity
  }

  return { ok: false, reason: "no_candidates", candidateIds: [] }
}

function matchOrderedIdentity(input: {
  workspaceId: string
  parsed: AmazonEmailParse
  receivedAt: Date | null
  rows: Array<{
    id: number
    store_id: number
    amazon_order_number: string | null
    buyer_name: string | null
    asin: string | null
    quantity: number | null
    order_created_at: string | null
    raw_ebay_order_json: unknown
  }>
}): MatchResult {
  const amazonNo = input.parsed.amazonOrderNumber?.trim() || null
  const mailFirst = firstNameNorm(input.parsed.recipientLabel)
  const mailCity = input.parsed.destinationCity
  const mailState = input.parsed.destinationState
  if (!mailFirst || !mailCity || !mailState || !input.receivedAt) {
    return { ok: false, reason: "no_candidates", candidateIds: [] }
  }

  const hits: number[] = []
  for (const r of input.rows) {
    if (r.amazon_order_number && amazonNo && r.amazon_order_number !== amazonNo) continue
    if (r.amazon_order_number && amazonNo && r.amazon_order_number === amazonNo) {
      // exact path already handled empty; skip
    }
    const addr = destFromRaw(r.raw_ebay_order_json)
    const orderName = addr.name || r.buyer_name
    const created = r.order_created_at ? new Date(r.order_created_at) : null
    const gate = identityGatesPass({
      mailFirstName: mailFirst,
      mailCity,
      mailState,
      orderFirstName: firstNameNorm(orderName),
      orderCity: addr.city,
      orderState: addr.state,
      mailReceivedAt: input.receivedAt,
      orderCreatedAt: created,
      parsedAsin: input.parsed.asin,
      orderAsin: r.asin,
      parsedQty: input.parsed.quantity,
      orderQty: r.quantity == null ? null : Number(r.quantity),
    })
    if (!gate.pass) continue
    hits.push(Number(r.id))
  }

  if (hits.length === 1) {
    const orderPk = hits[0]!
    if (amazonNo) {
      // conflict if another same-store order already owns this Amazon order number
      // (caller already returned exact match when this order owns it)
      const owned = input.rows.find(r => Number(r.id) === orderPk)
      if (owned?.amazon_order_number && owned.amazon_order_number !== amazonNo) {
        return { ok: false, reason: "weak_evidence", candidateIds: [orderPk] }
      }
      const other = input.rows.find(
        r => r.amazon_order_number === amazonNo && Number(r.id) !== orderPk
      )
      if (other) {
        return { ok: false, reason: "weak_evidence", candidateIds: [orderPk, Number(other.id)] }
      }
    }
    const storeId = Number(input.rows.find(r => Number(r.id) === orderPk)!.store_id)
    return { ok: true, orderPk, storeId, reason: "unique_name_city_state" }
  }
  if (hits.length > 1) {
    return { ok: false, reason: "ambiguous", candidateIds: hits }
  }
  return { ok: false, reason: "no_candidates", candidateIds: [] }
}

export async function findEbayOrderByEbayOrderId(input: {
  workspaceId: string
  ebayOrderId: string
}): Promise<{ orderPk: number; storeId: number } | null> {
  const id = input.ebayOrderId.trim()
  if (!id) return null
  const res = await query<{ id: number; store_id: number }>(
    `SELECT id, store_id FROM ebay_orders
     WHERE workspace_id = $1::uuid
       AND (ebay_order_id = $2 OR legacy_order_id = $2)
     LIMIT 2`,
    [input.workspaceId, id]
  )
  if (res.rows.length !== 1) return null
  return { orderPk: Number(res.rows[0]!.id), storeId: Number(res.rows[0]!.store_id) }
}
