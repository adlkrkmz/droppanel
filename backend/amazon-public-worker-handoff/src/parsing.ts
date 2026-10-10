export type KeepaObservation = {
  buyBox: number | null;
  amazon: number | null;
  newPrice: number | null;
  lastUpdateText: string | null;
  lastPriceChangeText: string | null;
  challenge: string | null;
  parsed: boolean;
  pageIdentified: boolean;
  method: 'HTTP' | 'PLAYWRIGHT';
};

export type AmazonOfferCondition = 'NEW' | 'RESALE' | 'USED' | 'LIKE_NEW' | 'RENEWED' | 'UNKNOWN';

export type AmazonObservation = {
  actualAsin: string | null;
  pageExists: boolean;
  mainPrice: number | null;
  primeMemberPrice: number | null;
  regularPrice: number | null;
  primeVisible: boolean | null;
  shipsFrom: string | null;
  soldBy: string | null;
  availability: string | null;
  inStock: boolean | null;
  offerLabel: string | null;
  offerCondition: AmazonOfferCondition;
  newOfferAvailable: boolean | null;
  finalUrl: string;
};

export type AmazonPageSnapshot = {
  body: string;
  title: string;
  canonical: string | null;
  finalUrl: string;
  asinMetadata: string | null;
  selectedAsinMetadata: string | null;
  mainPrices: string | null;
  primePrices: string | null;
  regularPrices: string | null;
  shipsFrom: string | null;
  soldBy: string | null;
  availability: string | null;
  offerLabel: string | null;
  offerContext: string | null;
  primeEvidence: string | null;
  offerContextComplete: boolean;
  newOfferEvidence: boolean;
  purchaseEvidence: boolean;
};

const pricePattern = /(?:[$€£]\s*\d{1,5}(?:[,.]\d{2})?|\d{1,5}(?:[,.]\d{2})?\s*(?:USD|EUR|GBP))/i;

function decodeHtml(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function money(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/\d{1,5}(?:[,.]\d{2})?/);
  if (!match) return null;
  const number = Number(match[0].replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function firstMoney(value: string | null): number | null {
  return money(value?.match(pricePattern)?.[0]);
}

function nearLabel(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const index = text.search(new RegExp(`\\b${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i'));
    if (index >= 0) {
      const price = text.slice(index, index + 260).match(pricePattern);
      const parsed = money(price?.[0]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

export function parseKeepaHtml(html: string, method: 'HTTP' | 'PLAYWRIGHT' = 'HTTP'): KeepaObservation {
  const challengeMatch = html.match(/(captcha|robot check|access denied|security challenge|rate.?limit|temporarily blocked)/i);
  if (challengeMatch) return { buyBox: null, amazon: null, newPrice: null, lastUpdateText: null, lastPriceChangeText: null, challenge: challengeMatch[1], parsed: false, pageIdentified: false, method };
  const text = `${decodeHtml(html)} ${html.replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>')}`;
  const buyBox = nearLabel(text, ['Buy Box', 'BuyBox']);
  const amazon = nearLabel(text, ['Amazon']);
  const newPrice = nearLabel(text, ['New']);
  const updateMatch = text.match(/(?:Last update|Last updated)\s*[:\-]?\s*([^|]{0,90})/i);
  const changeMatch = text.match(/(?:Last price change|Price change)\s*[:\-]?\s*([^|]{0,90})/i);
  const pageIdentified = /keepa/i.test(html) && (/product|price history|buy box|amazon|new/i.test(text));
  const parsed = pageIdentified && (buyBox !== null || amazon !== null || newPrice !== null);
  return { buyBox, amazon, newPrice, lastUpdateText: updateMatch?.[1]?.trim() ?? null, lastPriceChangeText: changeMatch?.[1]?.trim() ?? null, challenge: null, parsed, pageIdentified, method };
}

export function parseKeepaValues(text: string): KeepaObservation {
  return parseKeepaHtml(text);
}

export function priceText(value: number | null): string {
  return value === null ? '' : `$${value.toFixed(2)}`;
}

export function extractAsin(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (/^[A-Z0-9]{10}$/i.test(normalized)) return normalized.toUpperCase();
  const match = normalized.match(/(?:\/dp\/|\/gp\/product\/|product\/1-|(?:^|[?&#\s])asin[=:])([A-Z0-9]{10})(?=$|[/?&#\s])/i)
    ?? normalized.match(/\b([A-Z0-9]{10})\b/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function lineValue(text: string, labels: string[]): string | null {
  const lines = text.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const label = labels.find(candidate => new RegExp(`^${candidate}\\s*:?(?:\\s|$)`, 'i').test(line));
    if (!label) continue;
    const sameLine = line.replace(new RegExp(`^${label}\\s*:?\\s*`, 'i'), '').trim();
    if (sameLine) return sameLine.slice(0, 240);
    const next = lines[index + 1];
    if (next && !/^(ships from|shipper|sold by|seller|availability|in stock)/i.test(next)) return next.slice(0, 240);
  }
  return null;
}

function combinedShipperSeller(text: string, index: number): string | null {
  const line = text.split(/\r?\n/).map(value => value.replace(/\s+/g, ' ').trim()).find(value => /^shipper\s*\/\s*seller\s*:?[\s\S]+/i.test(value));
  const value = line?.replace(/^shipper\s*\/\s*seller\s*:?\s*/i, '').trim();
  return value?.split(/\s+\/\s+/)[index]?.trim().slice(0, 240) || null;
}

function fulfillmentValue(source: string | null, kind: 'ships' | 'sold', allowBareValue = false): string | null {
  if (!source) return null;
  const normalized = source.replace(/\s+/g, ' ').trim();
  const combined = normalized.match(/(?:Ships\s+from|Shipper)\s*\/\s*(?:Sold\s+by|Seller)\s*:?[\s]*([^|]+?)\s*\/\s*([^|]+?)(?:\s*\||$)/i);
  if (combined) return (kind === 'ships' ? combined[1] : combined[2]).trim().slice(0, 160) || null;
  const label = kind === 'ships' ? '(?:Ships\\s+from|Shipper)' : '(?:Sold\\s+by|Seller)';
  const other = kind === 'ships' ? '(?:Sold\\s+by|Seller)' : '(?:Ships\\s+from|Shipper)';
  const match = normalized.match(new RegExp(`${label}\\s*:?[\\s/]*([^|]+?)(?=\\s+${other}\\s*:|\\s*\\||$)`, 'i'));
  if (match?.[1]) return match[1].trim().replace(/\s*\/\s*$/, '').slice(0, 160) || null;
  if (allowBareValue && !/(?:Ships\s+from|Shipper|Sold\s+by|Seller)/i.test(normalized)) return normalized.slice(0, 160) || null;
  return null;
}

function cleanAvailability(...sources: Array<string | null | undefined>): string | null {
  const patterns = [
    /Only\s+\d{1,4}\s+left\s+in\s+stock(?:\s*[-–—]\s*order soon)?\.?/i,
    /We\s+don['’]?t\s+know\s+when\s+or\s+if\s+this\s+item\s+will\s+be\s+back\s+in\s+stock\.?/i,
    /Currently\s+(?:not\s+available|unavailable)\.?/i,
    /Temporarily\s+out\s+of\s+stock\.?/i,
    /Out\s+of\s+stock\.?/i,
    /\bIn\s+stock\.?/i
  ];
  for (const source of sources) {
    if (!source) continue;
    const normalized = source.replace(/\s+/g, ' ').trim();
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) return match[0].trim();
    }
  }
  return null;
}

function visibleOfferLabel(context: string | null, selected: string | null): string | null {
  const source = [selected, context].filter(Boolean).join(' ').replace(/\bnew\s*(?:&|and|or)\s*used\b/gi, '');
  const match = source.match(/(?:Buy\s+New|Buy\s+Resale|Resale:\s*(?:Very Good|Good|Like New|Acceptable)|Used\s*-\s*Like New|Amazon\s+Resale|Like New|Renewed|Used)/i);
  return match?.[0]?.replace(/\s+/g, ' ').trim() ?? null;
}

function offerCondition(label: string | null, context: string | null, newEvidence: boolean): AmazonOfferCondition {
  const source = `${label ?? ''} ${context ?? ''}`.replace(/\bnew\s*(?:&|and|or)\s*used\b/gi, '');
  if (/used\s*-\s*like\s*new|\blike\s+new\b/i.test(source)) return 'LIKE_NEW';
  if (/buy\s+resale|\bresale\s*:|amazon\s+resale/i.test(source)) return 'RESALE';
  if (/\brenewed\b/i.test(source)) return 'RENEWED';
  if (/\bused\b/i.test(source)) return 'USED';
  if (newEvidence || /buy\s+new|new\s+condition|new\s+offer/i.test(source)) return 'NEW';
  return 'UNKNOWN';
}

function hasExplicitUnavailability(value: string | null): boolean {
  return Boolean(value && /currently\s+(?:not\s+available|unavailable)|we\s+don.{0,2}t\s+know\s+when|out\s+of\s+stock|temporarily\s+out\s+of\s+stock/i.test(value));
}

function scopedPrime(value: string | null, primePrice: number | null, complete: boolean): boolean | null {
  if (primePrice !== null) return true;
  if (!value) return complete ? false : null;
  const actionable = value.replace(/join\s+prime|prime\s+members?\s+get\s+free\s+delivery|prime\s+membership/gi, ' ');
  const positive = /__PRIME_BADGE__|\bprime\b|prime\s+(?:delivery|eligible|shipping|badge)|(?:with|for)\s+prime|prime.{0,45}(?:arrives?|delivery|tomorrow|free)/i.test(actionable);
  if (positive) return true;
  return complete ? false : null;
}

export function parseAmazonSnapshot(snapshot: AmazonPageSnapshot): AmazonObservation {
  const text = `${snapshot.title}\n${snapshot.body}`;
  const actualAsin = extractAsin(snapshot.finalUrl) ?? extractAsin(snapshot.canonical) ?? extractAsin(snapshot.asinMetadata) ?? extractAsin(snapshot.selectedAsinMetadata);
  const notFound = /page not found|sorry!?\s+we couldn.{0,2}t find that page|the requested url was not found|product not found/i.test(text);
  const pageExists = !notFound && Boolean(actualAsin || /producttitle|add to cart|buy now|ships from|sold by|price|availability/i.test(text));
  const primeMemberPrice = firstMoney(snapshot.primePrices) ?? nearLabel(snapshot.offerContext ?? '', ['Prime Member Price', 'Prime Exclusive Price', 'Exclusive Prime price']);
  const mainPrice = firstMoney(snapshot.mainPrices);
  const availability = cleanAvailability(snapshot.availability, snapshot.offerContext, snapshot.body);
  const inStock = availability ? (/out of stock|currently\s+(?:not\s+available|unavailable)|unavailable|don.{0,2}t know when/i.test(availability) ? false : /in stock/i.test(availability) ? true : null) : null;
  const label = visibleOfferLabel(snapshot.offerContext, snapshot.offerLabel);
  const parsedCondition = offerCondition(label, snapshot.offerContext, snapshot.newOfferEvidence);
  const shipsFrom = fulfillmentValue(snapshot.shipsFrom, 'ships', true) ?? fulfillmentValue(snapshot.offerContext, 'ships');
  const soldBy = fulfillmentValue(snapshot.soldBy, 'sold', true) ?? fulfillmentValue(snapshot.offerContext, 'sold');
  const negativeCondition = /buy\s+resale|amazon\s+resale|\bresale\s*:|used\s*-\s*like\s*new|\blike\s+new\b|\brenewed\b|\bused\b/i.test(`${label ?? ''} ${snapshot.offerContext ?? ''}`.replace(/\bnew\s*(?:&|and|or)\s*used\b/gi, ''));
  const normalNewEvidence = parsedCondition === 'UNKNOWN'
    && !negativeCondition
    && snapshot.purchaseEvidence
    && mainPrice !== null
    && inStock === true
    && Boolean(snapshot.offerContextComplete || shipsFrom || soldBy);
  const condition = normalNewEvidence ? 'NEW' : parsedCondition;
  const explicitUnavailable = hasExplicitUnavailability(availability) || hasExplicitUnavailability(snapshot.offerContext);
  const newOfferAvailable = condition === 'RESALE' || condition === 'USED' || condition === 'LIKE_NEW' || condition === 'RENEWED'
    ? false
    : explicitUnavailable
      ? false
      : condition === 'NEW' && snapshot.purchaseEvidence && mainPrice !== null && inStock === true && Boolean(snapshot.offerContextComplete || shipsFrom || soldBy)
        ? true
        : null;
  return {
    actualAsin,
    pageExists,
    mainPrice,
    primeMemberPrice,
    regularPrice: firstMoney(snapshot.regularPrices),
    primeVisible: scopedPrime(snapshot.primeEvidence ?? snapshot.offerContext, primeMemberPrice, snapshot.offerContextComplete),
    shipsFrom: shipsFrom ?? lineValue(snapshot.shipsFrom ?? '', ['Ships from', 'Shipper']) ?? combinedShipperSeller(snapshot.shipsFrom ?? '', 0),
    soldBy: soldBy ?? lineValue(snapshot.soldBy ?? '', ['Sold by', 'Seller']) ?? combinedShipperSeller(snapshot.soldBy ?? '', 1),
    availability,
    inStock,
    offerLabel: label,
    offerCondition: condition,
    newOfferAvailable,
    finalUrl: snapshot.finalUrl
  };
}

export function classifyAmazonObservation(observation: AmazonObservation, requestedAsin: string): string {
  if (!observation.pageExists) return 'PRODUCT_NOT_FOUND_OBSERVED';
  if (!observation.actualAsin) return 'AMAZON_INCOMPLETE';
  if (observation.actualAsin !== requestedAsin.toUpperCase()) return 'ASIN_MISMATCH_OBSERVED';
  if (observation.offerCondition === 'RESALE' || observation.offerCondition === 'USED' || observation.offerCondition === 'LIKE_NEW' || observation.offerCondition === 'RENEWED') return 'NEW_OFFER_UNAVAILABLE';
  if (observation.newOfferAvailable === false && observation.inStock === false) return 'OUT_OF_STOCK_OBSERVED';
  if (observation.newOfferAvailable === false) return 'NEW_OFFER_UNAVAILABLE';
  if (observation.newOfferAvailable === true) return 'AMAZON_CHECKED';
  return 'AMAZON_INCOMPLETE';
}

export function challengeReason(text: string): string | null {
  const match = text.match(/(captcha|robot check|access denied|security challenge|rate.?limit|temporarily blocked|automated access)/i);
  return match?.[1] ?? null;
}
