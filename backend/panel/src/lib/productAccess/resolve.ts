import type { ProductAccessRecord, ProductAccessSnapshot } from "./types"

const DEFAULT_MOCK: ProductAccessRecord[] = [{ product: "EBAY", status: "ACTIVE" }]

function parseMockEnv(raw: string | undefined): ProductAccessRecord[] {
  const text = (raw ?? "").trim()
  if (!text) return DEFAULT_MOCK
  if (text.toUpperCase() === "NONE") return []

  const rows: ProductAccessRecord[] = []
  for (const part of text.split(",")) {
    const token = part.trim().toUpperCase()
    if (token === "EBAY") {
      rows.push({ product: token, status: "ACTIVE" })
    }
  }
  return rows.length > 0 ? rows : DEFAULT_MOCK
}

/**
 * MVP resolver for admin cookie sessions.
 * TODO: call backend user_product_access via authenticated user id when panel uses /auth/me.
 */
export function resolveMockProductAccess(): ProductAccessSnapshot {
  return {
    source: "mock",
    userId: null,
    access: parseMockEnv(process.env.MOCK_PRODUCT_ACCESS),
  }
}
