export type StockReviewStatus = "pending" | "processing" | "actioned" | "failed" | "ignored" | "approved"



export type StockReviewRisk = "NO_PRICE" | "UNAVAILABLE" | "REMOVED" | "PRICE_INCREASE"



export type StockAlertRow = {

  id: number

  storeId: number

  catalogStateId: number

  asin: string

  ebayItemId: string | null

  internalSku: string | null

  ebayTitle: string | null

  imageUrl: string | null

  ebayQuantity: number | null

  ebayPrice: number | null

  sourceStatus: string

  sourceStatusReason: string | null
  verificationSource: string | null

  sourcePrice: number | null
  oldSourcePrice: number | null
  newSourcePrice: number | null
  priceChangePercent: number | null
  detectedAt: string

  checkedAt: string | null

  reviewStatus: StockReviewStatus

  actionedAt: string | null

  actionError: string | null

  processingStartedAt: string | null
  storeMarkupPercent?: number | null
  recommendedEbayPrice?: number | null

}



export type StockAlertsListResponse = {

  ok: true

  rows: StockAlertRow[]

  total: number

  summary: {

    pending: number

    processing: number

    noPrice: number

    unavailable: number

    removed: number
    priceIncrease: number
  }
}



export type StockAlertsIgnoreRequest = {

  storeCode: string

  ids: number[]

}



export type StockAlertsIgnoreResponse = {

  ok: true

  ignored: number

}



export type StockAlertsApproveZeroRequest = {

  storeCode: string

  ids: number[]

}



export type StockAlertsApproveZeroResponse = {

  ok: true

  queued: true

  requested: number

  processing: number

  jobId: string

}



export class StockAlertsHttpError extends Error {

  constructor(

    readonly httpStatus: number,

    message: string

  ) {

    super(message)

    this.name = "StockAlertsHttpError"

  }

}


