import {
  AMAZON_ORDER_NUMBER_RE,
  ASIN_DP_RE,
  type AmazonEmailParse,
  type AmazonTrackUrlParts,
  type ParsedMoney,
} from "./mailboxTypes"

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim()
}

export function parseMoney(raw: string): ParsedMoney | null {
  const m = raw.match(/(?:(USD|US\$|EUR|GBP|CAD|AUD)\s*)?\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/i)
  if (!m) return null
  const amount = parseFloat(m[2]!.replace(/,/g, ""))
  if (!Number.isFinite(amount)) return null
  const curRaw = (m[1] ?? "USD").toUpperCase().replace("US$", "USD")
  const currency = curRaw === "$" ? "USD" : curRaw
  return { amount, currency: currency || "USD" }
}

export function parseAmazonOrderNumber(text: string): string | null {
  const labeled = text.match(/Amazon Order\s*#\s*(\d{3}-\d{7}-\d{7})/i)
  if (labeled?.[1]) return labeled[1]
  return text.match(AMAZON_ORDER_NUMBER_RE)?.[1] ?? null
}

export function parseAsinFromDpUrl(text: string): string | null {
  const m = text.match(ASIN_DP_RE)
  return m?.[1] ? m[1].toUpperCase() : null
}

export function parseAmazonTrackUrl(text: string): AmazonTrackUrlParts | null {
  const urlM = text.match(/https?:\/\/www\.amazon\.com\/[^\s]*progress-tracker[^\s]*/i)
    ?? text.match(/https?:\/\/www\.amazon\.com\/[^\s]*ship-track[^\s]*/i)
    ?? text.match(/https?:\/\/www\.amazon\.com\/gp\/your-account\/ship-track[^\s]*/i)
  if (!urlM) return null
  const trackingUrl = urlM[0].replace(/[>,]+$/, "")
  let orderId: string | null = null
  let packageIndex: string | null = null
  let shipmentId: string | null = null
  try {
    const u = new URL(trackingUrl)
    orderId = u.searchParams.get("orderId")
    packageIndex = u.searchParams.get("packageIndex")
    shipmentId = u.searchParams.get("shipmentId")
  } catch {
    const oid = trackingUrl.match(/orderId=([^&\s]+)/i)
    const pkg = trackingUrl.match(/packageIndex=([^&\s]+)/i)
    const shp = trackingUrl.match(/shipmentId=([^&\s]+)/i)
    orderId = oid?.[1] ?? null
    packageIndex = pkg?.[1] ?? null
    shipmentId = shp?.[1] ?? null
  }
  return { trackingUrl, orderId, packageIndex, shipmentId }
}

const US_STATE_RE = /^(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/

function isUsableCityState(city: string, state: string): boolean {
  const c = city.trim()
  const st = state.trim().toUpperCase()
  if (!US_STATE_RE.test(st)) return false
  if (c.length < 2 || c.length > 40) return false
  if (/\bsales tax\b|\bamazon\.com\b|\bselect states\b|\bapplicable laws\b/i.test(c)) return false
  if (!/^[A-Za-z][A-Za-z .'-]*$/.test(c)) return false
  return true
}

export function parseDestination(text: string): {
  recipientLabel: string | null
  city: string | null
  state: string | null
} {
  const dash = text.match(
    /\b([A-Za-z][A-Za-z'.-]{1,24})\s*[-–]\s*([A-Za-z][A-Za-z .'-]{2,40}),\s*([A-Z]{2})\b/
  )
  if (dash && isUsableCityState(dash[2]!, dash[3]!)) {
    return {
      recipientLabel: dash[1]!.trim(),
      city: dash[2]!.trim(),
      state: dash[3]!.trim().toUpperCase(),
    }
  }
  const delivering = text.match(
    /deliver(?:ing|ed)? to\s+([^,\n]+?)\s+in\s+([A-Za-z .'-]+),\s*([A-Z]{2})\b/i
  )
  if (delivering && isUsableCityState(delivering[2]!, delivering[3]!)) {
    return {
      recipientLabel: delivering[1]!.trim(),
      city: delivering[2]!.trim(),
      state: delivering[3]!.trim().toUpperCase(),
    }
  }
  return { recipientLabel: null, city: null, state: null }
}

export function parseArriving(text: string): string | null {
  const m =
    text.match(/arriving\s+([^\n.]{3,80})/i)
    ?? text.match(/now arriving\s+([^\n.]{3,80})/i)
    ?? text.match(/estimated (?:delivery|arrival)[:\s]+([^\n.]{3,80})/i)
  return m?.[1]?.trim() || null
}

export function parseGrandTotal(text: string): ParsedMoney | null {
  const line =
    text.match(/Grand Total[:\s]+([^\n]+)/i)
    ?? text.match(/\bTotal[:\s]+(\$[0-9,]+\.[0-9]{2}[^\n]*)/i)
  if (!line) return null
  return parseMoney(line[1]!)
}

export function parseAmazonOrderUrl(text: string, _orderNumber: string | null): string | null {
  const m = text.match(/https?:\/\/www\.amazon\.com\/gp\/your-account\/order-details[^\s]*/i)
  if (!m) return null
  return m[0].replace(/[>,]+$/, "")
}

function baseAmazon(type: AmazonEmailParse["type"]): AmazonEmailParse {
  return {
    type,
    amazonOrderNumber: null,
    recipientLabel: null,
    destinationCity: null,
    destinationState: null,
    estimatedDelivery: null,
    finalTotal: null,
    amazonOrderUrl: null,
    trackingUrl: null,
    trackParts: null,
    productTitle: null,
    asin: null,
    quantity: null,
    displayedItemPrice: null,
    deliveryLocationText: null,
    deliveredDateText: null,
    shipmentStatus: null,
  }
}

function parseProductTitleNearDpUrl(text: string): string | null {
  const idx = text.search(/https?:\/\/www\.amazon\.com\/(?:[^/\s]+\/)?dp\//i)
  if (idx < 0) return null
  const before = text.slice(Math.max(0, idx - 240), idx)
  const lines = before.split(/\n/).map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (line.length < 8) continue
    if (/^https?:/i.test(line)) continue
    if (/^(qty|quantity|amazon order|#)/i.test(line)) continue
    if (/^\$[0-9]/.test(line)) continue
    return line
  }
  return null
}

function fillCommon(out: AmazonEmailParse, text: string): void {
  out.amazonOrderNumber = parseAmazonOrderNumber(text)
  const dest = parseDestination(text)
  out.recipientLabel = dest.recipientLabel
  out.destinationCity = dest.city
  out.destinationState = dest.state
  out.estimatedDelivery = parseArriving(text)
  out.finalTotal = parseGrandTotal(text)
  out.amazonOrderUrl = parseAmazonOrderUrl(text, out.amazonOrderNumber)
  out.trackParts = parseAmazonTrackUrl(text)
  out.trackingUrl = out.trackParts?.trackingUrl ?? null
  out.asin = parseAsinFromDpUrl(text)
  const qty = text.match(/\bQty[:\s]+(\d+)/i) ?? text.match(/\bQuantity[:\s]+(\d+)/i)
  if (qty && out.quantity == null) out.quantity = parseInt(qty[1]!, 10) || null
}

export function parseAmazonOrderedEmail(text: string): AmazonEmailParse {
  const out = baseAmazon("AMAZON_ORDERED")
  fillCommon(out, text)
  return out
}

export function parseAmazonShippedEmail(text: string): AmazonEmailParse {
  const out = baseAmazon("AMAZON_SHIPPED")
  fillCommon(out, text)
  out.shipmentStatus = "SHIPPED"
  return out
}

export function parseAmazonDelayedEmail(text: string): AmazonEmailParse {
  const out = baseAmazon("AMAZON_DELAYED")
  fillCommon(out, text)
  out.shipmentStatus = "DELAYED"
  const qty = text.match(/\bQty[:\s]+(\d+)/i) ?? text.match(/\bQuantity[:\s]+(\d+)/i)
  if (qty) out.quantity = parseInt(qty[1]!, 10) || null
  const priceLine = text.match(/\$[0-9,]+\.[0-9]{2}/)
  if (priceLine) out.displayedItemPrice = parseMoney(priceLine[0])
  out.productTitle = parseProductTitleNearDpUrl(text)
  return out
}

export function parseAmazonDeliveredEmail(text: string): AmazonEmailParse {
  const out = baseAmazon("AMAZON_DELIVERED")
  fillCommon(out, text)
  out.shipmentStatus = "DELIVERED"
  const loc =
    text.match(/left (?:it )?((?:near|at|in|on)[^\n.]{3,80})/i)
    ?? text.match(/delivered (?:to|at) ([^\n.]{3,80})/i)
  out.deliveryLocationText = loc?.[1]?.trim() || null
  const when = text.match(/delivered today|delivered on ([^\n.]{3,40})/i)
  out.deliveredDateText = when ? (when[1]?.trim() || "today") : null
  return out
}

export function parseAmazonEmailByType(
  type: AmazonEmailParse["type"],
  text: string
): AmazonEmailParse {
  if (type === "AMAZON_ORDERED") return parseAmazonOrderedEmail(text)
  if (type === "AMAZON_SHIPPED") return parseAmazonShippedEmail(text)
  if (type === "AMAZON_DELAYED") return parseAmazonDelayedEmail(text)
  return parseAmazonDeliveredEmail(text)
}
