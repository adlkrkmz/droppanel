// ─────────────────────────────────────────────────────────────
// asinImportTypes.ts
// ─────────────────────────────────────────────────────────────

export type AsinImportSkipReason =
  | "ALREADY_LISTED_IN_STORE"
  | "ALREADY_LISTED_IN_WORKSPACE"
  | "ALREADY_IN_POOL"
  | "INVALID_ASIN"
  | "STORE_CONFLICT"

export type AsinImportSkipDetail = {
  asin:           string
  status:         "skipped"
  reason:         AsinImportSkipReason
  storeCode?:     string
  ebayItemId?:    string | null
  catalogStateId?: number
}

export type AsinImportRequest = {
  asins: string[]
}

export type AsinImportResponse = {
  totalInput:           number
  valid:                number
  inserted:             number
  skippedDuplicate:     number
  skippedStoreConflict: number
  skippedAlreadyListed: number
  invalid:              number
  invalidAsins:         string[]
  duplicateAsins:       string[]
  conflictAsins:        string[]
  alreadyListedAsins:   string[]
  insertedAsins:        string[]
  skipDetails?:         AsinImportSkipDetail[]
}
