export type QuantityMutationSource =
  | "manual_listing"
  | "sold_item_restock"
  | "automatic_zero"

const SOURCE_ENV = "EBAY_LIVE_QUANTITY_MUTATION_SOURCES"

/** Server-owned source allowlist; client request fields cannot select a source. */
export function isQuantityMutationSourceEnabled(
  source: QuantityMutationSource
): boolean {
  const enabled = new Set(
    (process.env[SOURCE_ENV] ?? "")
      .split(",")
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  )
  return enabled.has(source)
}

export function quantityMutationDisabledMessage(
  source: QuantityMutationSource
): string {
  return `eBay quantity mutation disabled for source=${source}`
}
