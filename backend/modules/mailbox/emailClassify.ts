import type { MailboxClassifiedType } from "./mailboxTypes"

export type ClassifyInput = {
  sender: string
  subject: string
  textBody: string
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase()
}

function senderHost(sender: string): string {
  const m = sender.toLowerCase().match(/@([a-z0-9.-]+)/)
  return m?.[1] ?? ""
}

export function isAmazonSender(sender: string): boolean {
  const host = senderHost(sender)
  return host === "amazon.com" || host.endsWith(".amazon.com")
}

export function isEbaySender(sender: string): boolean {
  const host = senderHost(sender)
  return host === "ebay.com" || host.endsWith(".ebay.com")
}

const AMAZON_PROMO = /lightning deal|today'?s deals|subscribe|amazon prime day|recommended for you|your amazon smil/i
const EBAY_PROMO = /daily deal|watch list|sparkle|coupon|don'?t miss|trending on ebay/i

/** Cheap Gmail-header gate: fetch full body only for these subjects. */
export function isTransactionalWhitelistCandidate(sender: string, subject: string): boolean {
  const s = norm(subject)
  if (isAmazonSender(sender)) {
    if (AMAZON_PROMO.test(subject)) return false
    return (
      /^ordered\b/.test(s) ||
      /\bordered \d+ item/.test(s) ||
      /\bshipped\b/.test(s) ||
      /\bdelivery update\b/.test(s) ||
      /\bdelivered\b/.test(s)
    )
  }
  if (isEbaySender(sender)) {
    if (EBAY_PROMO.test(subject)) return false
    return (
      /you made the sale/.test(s) ||
      /you sold|sold an item|congratulations, you sold/.test(s) ||
      /wants to cancel|cancel an order|cancellation request|successfully canceled|successfully cancelled/.test(s) ||
      /return request|requested a return|new return/.test(s) ||
      /we sent your payout|\bpayout\b/.test(s)
    )
  }
  return false
}

export function classifyMailboxEmail(input: ClassifyInput): MailboxClassifiedType {
  const sender = input.sender ?? ""
  const subject = input.subject ?? ""
  const body = input.textBody ?? ""
  const hay = `${subject}\n${body}`
  const s = norm(subject)
  const h = hay.toLowerCase()

  if (isAmazonSender(sender)) {
    if (AMAZON_PROMO.test(subject) || AMAZON_PROMO.test(body.slice(0, 400))) return "IGNORED"
    if (/^ordered\b/.test(s) || /\bordered \d+ item/.test(s)) return "AMAZON_ORDERED"
    if (/your package is delayed|package is delayed/.test(h) || (/\bdelivery update\b/.test(s) && /delayed/.test(h))) {
      return "AMAZON_DELAYED"
    }
    if (/was delivered|delivered today|your package was delivered/.test(h) || /^delivered\b/.test(s)) {
      return "AMAZON_DELIVERED"
    }
    if (/\bshipped\b/.test(s) || /on the way|package is on the way/.test(h)) {
      return "AMAZON_SHIPPED"
    }
    if (/\bdelivery update\b/.test(s)) return "AMAZON_DELAYED"
    return "UNKNOWN_TRANSACTIONAL"
  }

  if (isEbaySender(sender)) {
    if (EBAY_PROMO.test(subject)) return "IGNORED"
    if (/you made the sale|you sold|sold an item|congratulations, you sold/.test(h)) return "EBAY_SALE"
    if (/successfully canceled|successfully cancelled|you canceled an order|you cancelled an order/.test(h)) {
      return "EBAY_CANCELLED"
    }
    if (/wants to cancel|requested to cancel|cancel (an )?order|cancellation request/.test(h)) {
      return "EBAY_CANCEL_REQUEST"
    }
    if (/requested a return|return request|buyer started a return|you.?ve got a new return/.test(h)) {
      return "EBAY_RETURN_REQUEST"
    }
    if (/we sent your payout/.test(h) || (/\bpayout\b/.test(h) && /payout (id|amount|is on the way)/.test(h))) {
      return "EBAY_PAYOUT"
    }
    return "UNKNOWN_TRANSACTIONAL"
  }

  return "IGNORED"
}

export function isSupportedMailboxType(t: MailboxClassifiedType): boolean {
  return t !== "UNKNOWN_TRANSACTIONAL" && t !== "IGNORED"
}
