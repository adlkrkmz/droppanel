export function normalizeSupplierUrl(url: string | null | undefined): string {
  const raw = String(url ?? "").trim()
  if (!raw) return ""
  try {
    const parsed = new URL(raw)
    parsed.hash = ""
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "tag"]) parsed.searchParams.delete(key)
    return parsed.toString().replace(/\/$/, "").toLowerCase()
  } catch { return raw.toLowerCase() }
}

export function extractAmazonAsinFromUrl(url: string | null | undefined): string | null {
  const match = String(url ?? "").match(/(?:\/dp\/|\/gp\/product\/|\/product\/|[?&]asin=)([A-Z0-9]{10})(?:[/?&#]|$)/i)
  return match ? match[1].toUpperCase() : null
}
