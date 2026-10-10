import { extractBuyerFirstName } from "../customerService/csBuyerName"

/** Identity auto-match: eBay created within 24h before mail, or 2h after (clock skew). */
export const IDENTITY_LOOKBACK_MS = 24 * 60 * 60 * 1000
export const IDENTITY_LOOKAHEAD_MS = 2 * 60 * 60 * 1000

export function cityNorm(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
}

export function stateNorm(s: string | null | undefined): string {
  return String(s ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 2)
}

export function firstNameNorm(raw: string | null | undefined): string | null {
  const name = extractBuyerFirstName(raw)
  return name ? name.toLowerCase() : null
}

export function scoreAmazonCandidate(input: {
  parsedAsin: string | null
  parsedCity: string | null
  parsedState: string | null
  parsedQty: number | null
  candidateAsin: string | null
  candidateCity: string | null
  candidateState: string | null
  candidateQty: number | null
}): { score: number; pass: boolean } {
  const asin = input.parsedAsin?.trim().toUpperCase() || null
  const city = cityNorm(input.parsedCity)
  const state = (input.parsedState ?? "").trim().toUpperCase()
  let score = 0
  const asinMatch = Boolean(asin && input.candidateAsin && input.candidateAsin.toUpperCase() === asin)
  const cityMatch = Boolean(city && input.candidateCity && cityNorm(input.candidateCity) === city)
  const stateMatch = Boolean(state && input.candidateState && input.candidateState.toUpperCase() === state)
  const qtyMatch = input.parsedQty != null && input.candidateQty != null && Number(input.candidateQty) === input.parsedQty
  if (asinMatch) score += 3
  if (cityMatch && stateMatch) score += 2
  else if (cityMatch || stateMatch) score += 1
  if (qtyMatch) score += 1
  return { score, pass: score >= 5 && asinMatch }
}

export function identityGatesPass(input: {
  mailFirstName: string | null
  mailCity: string | null
  mailState: string | null
  orderFirstName: string | null
  orderCity: string | null
  orderState: string | null
  mailReceivedAt: Date | null
  orderCreatedAt: Date | null
  parsedAsin: string | null
  orderAsin: string | null
  parsedQty: number | null
  orderQty: number | null
}): { pass: boolean; reason?: string } {
  if (!input.mailFirstName || !input.orderFirstName || input.mailFirstName !== input.orderFirstName) {
    return { pass: false, reason: "name" }
  }
  if (!input.mailCity || !input.orderCity || cityNorm(input.mailCity) !== cityNorm(input.orderCity)) {
    return { pass: false, reason: "city" }
  }
  if (!input.mailState || !input.orderState || stateNorm(input.mailState) !== stateNorm(input.orderState)) {
    return { pass: false, reason: "state" }
  }
  if (!input.mailReceivedAt || !input.orderCreatedAt) return { pass: false, reason: "time" }
  const delta = input.mailReceivedAt.getTime() - input.orderCreatedAt.getTime()
  if (delta > IDENTITY_LOOKBACK_MS || delta < -IDENTITY_LOOKAHEAD_MS) {
    return { pass: false, reason: "time" }
  }
  const mailAsin = input.parsedAsin?.trim().toUpperCase() || null
  const orderAsin = input.orderAsin?.trim().toUpperCase() || null
  if (mailAsin && orderAsin && mailAsin !== orderAsin) return { pass: false, reason: "asin" }
  if (
    input.parsedQty != null &&
    input.orderQty != null &&
    Number(input.orderQty) !== input.parsedQty
  ) {
    return { pass: false, reason: "qty" }
  }
  return { pass: true }
}
