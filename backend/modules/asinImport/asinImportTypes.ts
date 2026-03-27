// ─────────────────────────────────────────────────────────────
// asinImportTypes.ts
// ─────────────────────────────────────────────────────────────

export type AsinImportRequest = {
  asins: string[]
}

export type AsinImportResponse = {
  totalInput:           number
  valid:                number
  inserted:             number
  skippedDuplicate:     number
  skippedStoreConflict: number
  invalid:              number
  invalidAsins:         string[]
  duplicateAsins:       string[]
  conflictAsins:        string[]
  insertedAsins:        string[]
}
