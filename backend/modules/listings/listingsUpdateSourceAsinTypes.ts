export type UpdateSourceAsinRequest = {
  storeCode: string
  catalogStateId: number
  newAsin: string
}

export type UpdateSourceAsinResponse = {
  ok: true
  catalogStateId: number
  newAsin: string
  previousAsin: string | null
  sourceStatus: string
  sourcePrice: number | null
  pendingAlertsIgnored: number
}
