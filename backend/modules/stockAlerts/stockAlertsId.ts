/** pg returns BIGINT as string — normalize so Map lookups match request ids */
export function normReviewItemId(id: unknown): number {
  const n = typeof id === "string" ? parseInt(id, 10) : Number(id)
  if (!Number.isFinite(n)) throw new Error(`Invalid stock review item id: ${String(id)}`)
  return n
}
