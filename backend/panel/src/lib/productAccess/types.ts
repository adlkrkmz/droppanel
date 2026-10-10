export type ProductId = "EBAY"

export type ProductAccessStatus = "ACTIVE" | "TRIAL" | "DISABLED"

export type ProductAccessRecord = {
  product: ProductId
  status: ProductAccessStatus
}

export type ProductAccessSnapshot = {
  /** TODO: replace mock resolver with GET /auth/product-access once multi-user panel auth ships. */
  source: "mock" | "api"
  userId: string | null
  access: ProductAccessRecord[]
}

export type RegisterProductHint = "ebay"

export function parseRegisterProduct(raw: string | null | undefined): RegisterProductHint | null {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "ebay") return v
  return null
}

export function registerHintToProductId(hint: RegisterProductHint): ProductId {
  return "EBAY"
}

export function hasUsableAccess(
  access: ProductAccessRecord[],
  product: ProductId
): boolean {
  return access.some(
    (row) => row.product === product && (row.status === "ACTIVE" || row.status === "TRIAL")
  )
}
