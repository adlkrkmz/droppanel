import type { ProductAccessSnapshot } from "./types"

export async function fetchProductAccess(): Promise<ProductAccessSnapshot | null> {
  const res = await fetch("/api/product-access", { cache: "no-store", credentials: "same-origin" })
  if (!res.ok) return null
  const data = (await res.json()) as ProductAccessSnapshot & { ok?: boolean }
  if (!data.access) return null
  return {
    source: data.source,
    userId: data.userId,
    access: data.access,
  }
}
