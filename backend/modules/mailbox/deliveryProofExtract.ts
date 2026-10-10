/**
 * Conservative delivery-proof photo detection from Amazon Delivered HTML.
 * Uncertain matches are rejected. Known template assets are never treated as proof.
 */

import { createHash } from "crypto"

const ASSET_HOST_RE =
  /(^|\.)m\.media-amazon\.com$|(^|\.)images-na\.ssl-images-amazon\.com$|(^|\.)images-amazon\.com$|(^|\.)ssl-images-amazon\.com$|(^|\.)amazon-adsystem\.com$|(^|\.)fls-na\.amazon\.com$/i

const ASSET_PATH_RE = /logo|banner|sprite|icon|thumb|pixel|tracking|beacon|smiley|emoji|badge|illustration|widget/i

const IMG_SRC_RE = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi
const CSS_URL_RE = /url\((['"]?)(https:[^'")]+)\1\)/gi

export function extractDeliveryProofSourceUrl(html: string | null | undefined): string | null {
  if (!html?.trim()) return null
  const urls = collectHttpsUrls(html)
  const proofs = urls.filter(isConservativeDeliveryProofUrl)
  if (proofs.length === 0) return null
  const signed = proofs.find(u => hasAwsSignature(u) && /imageid-/i.test(pathnameOf(u)))
  return signed ?? proofs[0] ?? null
}

export function isConservativeDeliveryProofUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  const host = url.hostname.toLowerCase()
  if (ASSET_HOST_RE.test(host)) return false
  if (ASSET_PATH_RE.test(url.pathname) || ASSET_PATH_RE.test(raw)) return false
  if (/\.gif(?:$|\?)/i.test(url.pathname)) return false
  if (/_sx\d+_|_sy\d+_|_ss\d+_/i.test(raw)) return false

  const s3Like = /(^|\.)s3[.-][a-z0-9-]*\.amazonaws\.com$|(^|\.)s3\.amazonaws\.com$/i.test(host)
  if (!s3Like) return false
  const hasImageId = /imageid-/i.test(url.pathname)
  const signed = hasAwsSignature(url)
  if (!hasImageId && !signed) return false
  if (signed && !hasImageId && url.pathname.length < 8) return false
  return true
}

export function stripSignedQuery(raw: string): string {
  try {
    const u = new URL(raw)
    u.search = ""
    u.hash = ""
    return u.toString()
  } catch {
    return raw.split("?")[0] ?? raw
  }
}

function hasAwsSignature(url: string | URL): boolean {
  const u = typeof url === "string" ? (() => { try { return new URL(url) } catch { return null } })() : url
  if (!u) return false
  return Boolean(u.searchParams.get("X-Amz-Signature") || u.searchParams.get("X-Amz-Algorithm"))
}

function pathnameOf(raw: string): string {
  try {
    return new URL(raw).pathname
  } catch {
    return raw
  }
}

function collectHttpsUrls(html: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const decoded = htmlDecode(raw).trim()
    if (!decoded.startsWith("https://")) return
    if (seen.has(decoded)) return
    seen.add(decoded)
    out.push(decoded)
  }
  let m: RegExpExecArray | null
  const imgRe = new RegExp(IMG_SRC_RE.source, "gi")
  while ((m = imgRe.exec(html)) !== null) push(m[1] ?? "")
  const cssRe = new RegExp(CSS_URL_RE.source, "gi")
  while ((m = cssRe.exec(html)) !== null) push(m[2] ?? "")
  return out
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}

export function deliveryProofObjectKey(input: {
  workspaceId: string
  storeId: number
  ebayOrderId: string
  mailboxMessageId: number
  ext: string
}): string {
  const material = `${input.workspaceId}|${input.storeId}|${input.ebayOrderId}|${input.mailboxMessageId}`
  const digest = createHash("sha256").update(material).digest("hex")
  const ext = input.ext === "jpeg" ? "jpg" : input.ext
  return `delivery-proofs/${input.workspaceId}/${input.storeId}/${digest}.${ext}`
}

export function isSafePublicProofUrl(url: string | null | undefined): boolean {
  const raw = (url ?? "").trim()
  if (!raw.startsWith("https://")) return false
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  const publicBase = (process.env.R2_PUBLIC_URL ?? "").trim().replace(/\/+$/, "")
  if (publicBase) {
    try {
      const base = new URL(publicBase.startsWith("http") ? publicBase : `https://${publicBase}`)
      if (parsed.hostname !== base.hostname) return false
    } catch {
      return false
    }
  } else if (parsed.hostname !== "img.listjetgo.com") {
    return false
  }
  return parsed.pathname.includes("/delivery-proofs/")
}
