import { NormalizedAsinRow } from "./importTypes"

export const ASIN_REGEX = /^[A-Z0-9]{10}$/

export function normalizeAsinValue(value: string): string {
  return value.trim().toUpperCase()
}

export function isValidAsin(value: string): boolean {
  return ASIN_REGEX.test(value)
}

export function normalizeInputLines(lines: string[]): NormalizedAsinRow[] {
  return lines.map((line, index) => ({
    rawValue: line,
    normalizedValue: normalizeAsinValue(line),
    lineNumber: index + 1
  }))
}

export function parseCsvLine(row: string): string[] {
  return row.split(",").map((part) => part.trim())
}

export function isBlankRow(row: string): boolean {
  return row.trim().length === 0
}

export function resolveAsinColumnIndex(headerCells: string[]): number {
  const normalized = headerCells.map((cell) => cell.trim().toLowerCase())
  return normalized.findIndex((cell) => cell === "asin")
}

export function flattenCsvRows(rows: string[]): string[] {
  const nonBlankRows = rows.filter((row) => !isBlankRow(row))

  if (nonBlankRows.length === 0) {
    return []
  }

  const firstRowCells = parseCsvLine(nonBlankRows[0])
  const asinColumnIndex = resolveAsinColumnIndex(firstRowCells)

  if (asinColumnIndex >= 0) {
    const dataRows = nonBlankRows.slice(1)

    return dataRows.map((row) => {
      const cells = parseCsvLine(row)
      const value = cells[asinColumnIndex] ?? ""
      return normalizeAsinValue(value)
    })
  }

  return nonBlankRows.map((row) => {
    const cells = parseCsvLine(row)
    const value = cells[0] ?? ""
    return normalizeAsinValue(value)
  })
}

export function dedupeByNormalizedValue(
  rows: NormalizedAsinRow[]
): NormalizedAsinRow[] {
  const seen = new Set<string>()
  const output: NormalizedAsinRow[] = []

  for (const row of rows) {
    if (!row.normalizedValue) {
      output.push(row)
      continue
    }

    if (seen.has(row.normalizedValue)) {
      continue
    }

    seen.add(row.normalizedValue)
    output.push(row)
  }

  return output
}