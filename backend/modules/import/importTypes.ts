export type ImportClassName =
  | "ready_for_pool"
  | "skipped_duplicate_pool"
  | "invalid_asin"

export type ImportInputMode = "manual_list" | "csv_rows"

export type ImportRawInput = {
  workspaceId: string
  sourceType: ImportInputMode
  sourceName?: string | null
  uploadedBy?: string | null
  lines: string[]
}

export type NormalizedAsinRow = {
  rawValue: string
  normalizedValue: string
  lineNumber: number
}

export type ProcessedImportRow = {
  rawValue: string
  normalizedValue: string
  lineNumber: number
  classification: ImportClassName
  asinRegistryId?: number
  reason?: string
}

export type ImportSummary = {
  workspaceId: string
  sourceType: ImportInputMode
  sourceName: string | null
  uploadedBy: string | null
  totalRows: number
  validRows: number
  readyCount: number
  skippedDuplicatePoolCount: number
  invalidCount: number
  rows: ProcessedImportRow[]
}

export type BlacklistCheckResult = {
  blocked: boolean
  reason?: string
}

export type CooldownCheckResult = {
  blocked: boolean
  reason?: string
}