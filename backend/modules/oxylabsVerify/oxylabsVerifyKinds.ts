export const OXYLABS_PRODUCT_PRIMARY = "OXYLABS_PRODUCT_PRIMARY"
export const OXYLABS_PRODUCT_CONFIRM = "OXYLABS_PRODUCT_CONFIRM"
export const OXYLABS_PROVIDER = "OXYLABS_PRODUCT"

export type OxylabsVerifyJobKind = typeof OXYLABS_PRODUCT_PRIMARY | typeof OXYLABS_PRODUCT_CONFIRM
export type OxylabsVerifyRole = "PRIMARY" | "CONFIRM"

export function isOxylabsVerifyJobKind(kind: string | null | undefined): kind is OxylabsVerifyJobKind {
  const k = String(kind ?? "")
  return k === OXYLABS_PRODUCT_PRIMARY || k === OXYLABS_PRODUCT_CONFIRM
}

export function resolveOxylabsVerifyClaimKind(workerId: string): OxylabsVerifyJobKind | null {
  const id = String(workerId ?? "").trim()
  if (id === "oxylabs-product-primary-A") return OXYLABS_PRODUCT_PRIMARY
  return null
}

export function oxylabsWorkerIdForRole(role: OxylabsVerifyRole, slot: string): string {
  const s = String(slot ?? "").trim().toUpperCase() || "A"
  if (role === "CONFIRM") return `oxylabs-product-confirm-${s}`
  return `oxylabs-product-primary-${s}`
}

export function oxylabsJobClaimableByWorker(workerId: string, jobKind: string): boolean {
  return resolveOxylabsVerifyClaimKind(workerId) === jobKind
}
