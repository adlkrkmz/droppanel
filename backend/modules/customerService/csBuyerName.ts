/**
 * Customer-facing first name, greeting, ETA, and delivery-location rendering.
 * Buyer username is never treated as a personal name.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const

const UNSAFE_NAME_RE = /[@#$%^*=+[\]{}|\\/<>]|https?:|www\./i
const MASKED_RE = /\*{2,}|x{3,}|\.{3,}/i
const SYSTEM_NAME_RE = /^(unknown|n\/?a|none|null|undefined|guest|buyer|customer|user|test)$/i

export function extractBuyerFirstName(fullName: string | null | undefined, buyerUsername?: string | null): string | null {
  const raw = (fullName ?? "").trim()
  if (!raw) return null
  if (raw.includes("@")) return null
  if (UNSAFE_NAME_RE.test(raw)) return null
  if (MASKED_RE.test(raw)) return null
  if (/^\d+$/.test(raw)) return null
  if (SYSTEM_NAME_RE.test(raw)) return null

  const username = (buyerUsername ?? "").trim()
  if (username && raw.toLowerCase() === username.toLowerCase()) return null

  // Usernames are typically a single token with digits or no spaces.
  if (!/\s/.test(raw) && /\d/.test(raw)) return null
  if (!/\s/.test(raw) && raw === raw.toLowerCase() && raw.length >= 8) return null

  const firstToken = raw.split(/\s+/)[0] ?? ""
  if (!/^[A-Za-z][A-Za-z'-]{1,23}$/.test(firstToken)) return null
  if (/\d/.test(firstToken)) return null
  if (SYSTEM_NAME_RE.test(firstToken)) return null

  if (/^[A-Z][a-z]+(?:['-][A-Za-z]+)*$/.test(firstToken)) return firstToken
  const titled = firstToken.charAt(0).toUpperCase() + firstToken.slice(1).toLowerCase()
  if (!/^[A-Z][a-z]+(?:['-][a-z]+)*$/.test(titled)) return null
  return titled
}

export function renderGreeting(firstName: string | null): string {
  if (firstName) return `Hi ${firstName},`
  return "Hello,"
}

export function formatCustomerEta(raw: string | null | undefined, now = new Date()): string | null {
  const text = (raw ?? "").trim()
  if (!text) return null
  if (/undefined|null/i.test(text)) return null
  if (/T\d{2}:\d{2}/.test(text) || /^\d{4}-\d{2}-\d{2}/.test(text)) {
    const d = parseDateOnly(text)
    if (!d) return null
    const month = MONTHS[d.getUTCMonth()]
    const day = d.getUTCDate()
    const year = d.getUTCFullYear()
    if (year !== now.getUTCFullYear()) return `${month} ${day}, ${year}`
    return `${month} ${day}`
  }
  const cleaned = text.replace(/\s+/g, " ").trim()
  if (cleaned.length > 80) return null
  if (/https?:|www\.|<|>/i.test(cleaned)) return null
  return cleaned
}

function parseDateOnly(text: string): Date | null {
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) {
    const d = new Date(text)
    if (Number.isNaN(d.getTime())) return null
    return d
  }
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null
  return new Date(Date.UTC(year, month - 1, day))
}

export function formatDeliveryLocationCustomerText(raw: string | null | undefined): string | null {
  let text = (raw ?? "").trim()
  if (!text) return null
  if (/https?:|www\.|<|>|&lt;|&gt;|javascript:/i.test(text)) return null
  if (text.length > 80) return null
  text = text.replace(/^your package was\s+/i, "")
  text = text.replace(/^it was\s+/i, "")
  text = text.replace(/^(?:left\s+)+/i, "")
  text = text.replace(/\s+/g, " ").trim().replace(/[.,]+$/, "")
  if (!text) return null
  if (!/^(near|at|in|on|with)\b/i.test(text)) return null
  const lower = text.toLowerCase()
  if (lower.includes("left left")) return null
  return lower
}
