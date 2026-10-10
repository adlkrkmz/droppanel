export type PricingRangeRow = {
  minPrice: string
  maxPrice: string
  minNetProfit: string
}

export type TieredProfitRange = {
  minPrice: number
  maxPrice: number
  minNetProfit: number
}

function toCents(value: number): number {
  return Math.round(value * 100)
}

/**
 * Normalize user/locale money text to a finite number.
 * "24,99" → 24.99; "24.99" → 24.99; leaves integer strings alone.
 */
export function parseMoneyInput(raw: string): number {
  const s = raw.trim().replace(/\s/g, "")
  if (!s) return NaN

  let normalized = s
  if (s.includes(",") && s.includes(".")) {
    const lastComma = s.lastIndexOf(",")
    const lastDot = s.lastIndexOf(".")
    if (lastComma > lastDot) {
      // European: 1.234,56
      normalized = s.replace(/\./g, "").replace(",", ".")
    } else {
      // US grouping: 1,234.56
      normalized = s.replace(/,/g, "")
    }
  } else if (s.includes(",")) {
    normalized = s.replace(",", ".")
  }

  return Number(normalized)
}

export function emptyPricingRangeRow(): PricingRangeRow {
  return { minPrice: "", maxPrice: "", minNetProfit: "" }
}

export function rangesToFormRows(ranges: TieredProfitRange[]): PricingRangeRow[] {
  if (!Array.isArray(ranges) || ranges.length === 0) return []
  return ranges.map(r => ({
    minPrice: String(r.minPrice),
    maxPrice: String(r.maxPrice),
    minNetProfit: String(r.minNetProfit),
  }))
}

/** Validate + normalize form rows. Returns error message or parsed ranges. */
export function validatePricingRangeRows(
  rows: PricingRangeRow[]
): { ok: true; ranges: TieredProfitRange[] } | { ok: false; error: string } {
  const parsed: TieredProfitRange[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const minPrice = parseMoneyInput(row.minPrice)
    const maxPrice = parseMoneyInput(row.maxPrice)
    const minNetProfit = parseMoneyInput(row.minNetProfit)
    if (
      row.minPrice.trim() === "" ||
      row.maxPrice.trim() === "" ||
      row.minNetProfit.trim() === "" ||
      !Number.isFinite(minPrice) ||
      !Number.isFinite(maxPrice) ||
      !Number.isFinite(minNetProfit)
    ) {
      return { ok: false, error: "Enter valid numbers for min, max, and profit." }
    }
    if (minPrice < 0 || maxPrice < 0 || minNetProfit < 0) {
      return { ok: false, error: "Values cannot be negative." }
    }
    if (toCents(minPrice) >= toCents(maxPrice)) {
      return { ok: false, error: "Min price must be less than max price." }
    }
    parsed.push({
      minPrice: Math.round((minPrice + Number.EPSILON) * 100) / 100,
      maxPrice: Math.round((maxPrice + Number.EPSILON) * 100) / 100,
      minNetProfit: Math.round((minNetProfit + Number.EPSILON) * 100) / 100,
    })
  }

  const sorted = [...parsed].sort((a, b) => {
    const byMin = toCents(a.minPrice) - toCents(b.minPrice)
    if (byMin !== 0) return byMin
    return toCents(a.maxPrice) - toCents(b.maxPrice)
  })

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]
      const b = sorted[j]
      if (toCents(a.minPrice) === toCents(b.minPrice) && toCents(a.maxPrice) === toCents(b.maxPrice)) {
        return { ok: false, error: "Duplicate price ranges are not allowed." }
      }
      if (toCents(a.maxPrice) >= toCents(b.minPrice) && toCents(b.maxPrice) >= toCents(a.minPrice)) {
        return { ok: false, error: "Price ranges cannot overlap." }
      }
    }
  }

  return { ok: true, ranges: sorted }
}
