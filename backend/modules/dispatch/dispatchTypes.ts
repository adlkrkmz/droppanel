// ─────────────────────────────────────────────────────────────
// dispatchTypes.ts
// ─────────────────────────────────────────────────────────────

export type SelectionMode = "random" | "priority" | "fifo"

export type DispatchOptions = {
  storeCode:     string
  count:         number
  selectionMode: SelectionMode
  delaySeconds:  number
  workspaceId:   string
}

export type DispatchCandidate = {
  poolId:         number
  asinRegistryId: number
  asin:           string
  priority:       number
}

export type StoreRow = {
  id:        number
  name:      string
  storeCode: string
  status:    string
}

export type DispatchResult = {
  storeId:         number
  storeCode:       string
  storeName:       string
  selectionMode:   SelectionMode
  delaySeconds:    number
  selectedCount:   number
  skippedCount:    number
  assignedPoolIds: number[]
  assignedAsins:   string[]
  dispatchedAt:    string
}
