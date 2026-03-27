// ─────────────────────────────────────────────────────────────
// monitorActionsTypes.ts
// ─────────────────────────────────────────────────────────────

export type UpdatePriceRequest = {
  storeCode: string
  sku:       string
  newPrice:  number
}

export type UpdatePriceResponse = {
  success:    boolean
  simulation: boolean
  sku:        string
  newPrice:   number
  message:    string
}

export type UpdateStockRequest = {
  storeCode: string
  sku:       string
  quantity:  number
}

export type UpdateStockResponse = {
  success:    boolean
  simulation: boolean
  sku:        string
  quantity:   number
  message:    string
}

export type BlindRequest = {
  storeCode: string
  sku:       string
}

export type BlindResponse = {
  success:    boolean
  simulation: boolean
  sku:        string
  message:    string
}
