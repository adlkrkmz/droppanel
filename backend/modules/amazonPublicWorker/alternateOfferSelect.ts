/**
 * When primary buybox offer is not Amazon-fulfilled NEW, prefer a visible
 * buybox accordion alternate ("Another way to buy") that is NEW + Ships from Amazon.
 * Does not change Stock Guard rules — only which offer fields feed them.
 */
import { shipsFromAmazon } from '../amazonVerification/amazonVerificationNormalize'
import { normalizePublicShipsFromBlob } from './mapPublicObservationToVerificationPayload'
import type { AmazonObservation, AmazonOfferCondition } from './parsing'

export type AccordionOfferRaw = {
  id: string
  buyingType: string | null
  caption: string | null
  priceText: string | null
  shipsFrom: string | null
  soldBy: string | null
  availability: string | null
  primeEvidence: string | null
  primeIcon: boolean
  rowText: string
}

export type SelectedOfferSummary = {
  price: number | null
  condition: string | null
  prime: boolean | null
  shipsFrom: string | null
  soldBy: string | null
  availability: string | null
}

export type OfferSelectionResult = {
  observation: AmazonObservation
  publicStatusHint: string | null
  finalSelectedSource: 'PRIMARY' | 'ALTERNATE' | 'NONE'
  primary: SelectedOfferSummary
  alternate: SelectedOfferSummary | null
  alternateFound: boolean
}

function money(value: string | null | undefined): number | null {
  if (!value) return null
  const match = value.replace(/,/g, '').match(/(\d+(?:\.\d{2})?)/)
  if (!match) return null
  const n = Number(match[1])
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

function rowLooksUsedOrResale(row: AccordionOfferRaw): boolean {
  const blob = `${row.buyingType ?? ''} ${row.caption ?? ''} ${row.rowText}`.replace(/\bnew\s*(?:&|and|or)\s*used\b/gi, '')
  if (/used\s*-\s*like\s*new|\blike\s+new\b|\brenewed\b|\bresale\b|\bused\b/i.test(blob)) return true
  if (row.buyingType && !/^new$/i.test(row.buyingType.trim())) return true
  return false
}

function rowIsNew(row: AccordionOfferRaw): boolean {
  if (rowLooksUsedOrResale(row)) return false
  if (row.buyingType && /^new$/i.test(row.buyingType.trim())) return true
  if (/another way to buy|one-time purchase|buy new|\bnew\b/i.test(`${row.caption ?? ''} ${row.rowText.slice(0, 120)}`)) {
    return !rowLooksUsedOrResale(row)
  }
  return false
}

function rowInStock(row: AccordionOfferRaw): boolean | null {
  const t = `${row.availability ?? ''} ${row.rowText}`
  if (/currently unavailable|out of stock|temporarily out of stock|don.?t know when/i.test(t)) return false
  if (/\bin stock\b|only\s+\d+\s+left/i.test(t)) return true
  return null
}

function rowPrime(row: AccordionOfferRaw): boolean | null {
  if (row.primeIcon) return true
  const evidence = `${row.primeEvidence ?? ''} ${row.rowText}`
  const actionable = evidence.replace(/join\s+prime|prime\s+membership/gi, ' ')
  if (/__PRIME_BADGE__|get\s+fast,?\s+free\s+shipping\s+with\s+amazon\s+prime|with\s+amazon\s+prime|\ba-icon-prime\b/i.test(actionable)) {
    return true
  }
  if (/get\s+fast,?\s+free\s+shipping\s+with\s+amazon\s+prime/i.test(evidence)) return true
  return null
}

export function accordionOfferIsAmazonFulfilledNew(row: AccordionOfferRaw): boolean {
  if (!rowIsNew(row)) return false
  const ships = normalizePublicShipsFromBlob(row.shipsFrom) ?? row.shipsFrom
  if (shipsFromAmazon(ships) !== true) return false
  const price = money(row.priceText)
  if (price == null) return false
  if (rowInStock(row) === false) return false
  return true
}

/** Primary is good enough to keep (Amazon-fulfilled NEW with price). */
export function primaryIsAmazonFulfilledNew(observation: AmazonObservation): boolean {
  if (!observation.pageExists) return false
  if (
    observation.offerCondition === 'USED' ||
    observation.offerCondition === 'RESALE' ||
    observation.offerCondition === 'LIKE_NEW' ||
    observation.offerCondition === 'RENEWED'
  ) {
    return false
  }
  if (observation.offerCondition !== 'NEW' && observation.newOfferAvailable !== true) return false
  const ships = normalizePublicShipsFromBlob(observation.shipsFrom) ?? observation.shipsFrom
  if (shipsFromAmazon(ships) !== true) return false
  if (observation.mainPrice == null || observation.mainPrice <= 0) return false
  if (observation.inStock === false) return false
  return true
}

function summaryFromObservation(obs: AmazonObservation): SelectedOfferSummary {
  return {
    price: obs.mainPrice,
    condition: obs.offerCondition,
    prime: obs.primeVisible,
    shipsFrom: obs.shipsFrom,
    soldBy: obs.soldBy,
    availability: obs.availability,
  }
}

function summaryFromAccordion(row: AccordionOfferRaw): SelectedOfferSummary {
  return {
    price: money(row.priceText),
    condition: rowIsNew(row) ? 'NEW' : rowLooksUsedOrResale(row) ? 'USED' : row.buyingType,
    prime: rowPrime(row),
    shipsFrom: normalizePublicShipsFromBlob(row.shipsFrom) ?? row.shipsFrom,
    soldBy: row.soldBy,
    availability: row.availability ?? (rowInStock(row) === true ? 'In Stock' : null),
  }
}

function applyAlternateToObservation(
  primary: AmazonObservation,
  row: AccordionOfferRaw
): AmazonObservation {
  const price = money(row.priceText)
  const ships = normalizePublicShipsFromBlob(row.shipsFrom) ?? row.shipsFrom
  const inStock = rowInStock(row)
  let prime = rowPrime(row)
  // Amazon.com retail + Ships from Amazon.com: treat as Prime-visible when badge parse misses.
  if (
    prime == null &&
    shipsFromAmazon(ships) === true &&
    /^amazon(\.com)?$/i.test((row.soldBy || '').trim())
  ) {
    prime = true
  }
  const availability =
    row.availability ??
    (inStock === true ? 'In Stock' : inStock === false ? 'Currently unavailable' : primary.availability)
  return {
    ...primary,
    mainPrice: price,
    priceMissing: price == null || price <= 0,
    shipsFrom: ships,
    soldBy: row.soldBy,
    availability,
    inStock: inStock === null ? primary.inStock ?? true : inStock,
    offerLabel: row.caption || 'Buy New',
    offerCondition: 'NEW',
    newOfferAvailable: true,
    primeVisible: prime,
  }
}

/**
 * Keep primary when it is already Amazon-fulfilled NEW; else first qualifying alternate.
 */
export function selectOfferObservation(input: {
  primary: AmazonObservation
  accordionOffers: AccordionOfferRaw[]
}): OfferSelectionResult {
  const primarySummary = summaryFromObservation(input.primary)
  const alternates = input.accordionOffers.filter((row, index) => {
    // Skip first accordion if it duplicates the active primary merchant+price
    if (index === 0) {
      const pPrice = input.primary.mainPrice
      const rPrice = money(row.priceText)
      const samePrice = pPrice != null && rPrice != null && Math.abs(pPrice - rPrice) < 0.001
      const ships = (row.shipsFrom || '').toLowerCase()
      const primaryShips = (input.primary.shipsFrom || '').toLowerCase()
      if (samePrice && ships && primaryShips && (ships.includes(primaryShips.slice(0, 12)) || primaryShips.includes(ships.slice(0, 12)))) {
        return false
      }
    }
    // Prefer rows labeled alternate / another way, but any Amazon NEW row after primary is OK
    return accordionOfferIsAmazonFulfilledNew(row)
  })

  // Prefer "Another way to buy" caption, then Amazon.com sold, then lowest price among Amazon-fulfilled
  alternates.sort((a, b) => {
    const score = (r: AccordionOfferRaw) => {
      let s = 0
      if (/another way to buy/i.test(r.caption || '')) s += 100
      if (/^amazon\.com$/i.test((r.soldBy || '').trim())) s += 50
      if (rowPrime(r) === true) s += 10
      return s
    }
    const d = score(b) - score(a)
    if (d !== 0) return d
    return (money(a.priceText) ?? 9999) - (money(b.priceText) ?? 9999)
  })

  const best = alternates[0] ?? null
  const alternateSummary = best ? summaryFromAccordion(best) : null

  if (primaryIsAmazonFulfilledNew(input.primary)) {
    return {
      observation: input.primary,
      publicStatusHint: null,
      finalSelectedSource: 'PRIMARY',
      primary: primarySummary,
      alternate: alternateSummary,
      alternateFound: Boolean(best),
    }
  }

  if (best) {
    const observation = applyAlternateToObservation(input.primary, best)
    return {
      observation,
      publicStatusHint: 'AMAZON_CHECKED',
      finalSelectedSource: 'ALTERNATE',
      primary: primarySummary,
      alternate: alternateSummary,
      alternateFound: true,
    }
  }

  return {
    observation: input.primary,
    publicStatusHint: null,
    finalSelectedSource: input.primary.pageExists ? 'PRIMARY' : 'NONE',
    primary: primarySummary,
    alternate: null,
    alternateFound: false,
  }
}
