export const MAILBOX_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ")

export type MailboxClassifiedType =
  | "AMAZON_ORDERED"
  | "AMAZON_SHIPPED"
  | "AMAZON_DELAYED"
  | "AMAZON_DELIVERED"
  | "EBAY_SALE"
  | "EBAY_CANCEL_REQUEST"
  | "EBAY_CANCELLED"
  | "EBAY_RETURN_REQUEST"
  | "EBAY_PAYOUT"
  | "UNKNOWN_TRANSACTIONAL"
  | "IGNORED"

export type MailboxProcessingStatus =
  | "PENDING"
  | "PROCESSED"
  | "IGNORED"
  | "NEEDS_REVIEW"
  | "FAILED"

export type ParsedMoney = {
  amount: number
  currency: string
}

export type AmazonTrackUrlParts = {
  trackingUrl: string
  orderId: string | null
  packageIndex: string | null
  shipmentId: string | null
}

export type AmazonEmailParse = {
  type: "AMAZON_ORDERED" | "AMAZON_SHIPPED" | "AMAZON_DELAYED" | "AMAZON_DELIVERED"
  amazonOrderNumber: string | null
  recipientLabel: string | null
  destinationCity: string | null
  destinationState: string | null
  estimatedDelivery: string | null
  finalTotal: ParsedMoney | null
  amazonOrderUrl: string | null
  trackingUrl: string | null
  trackParts: AmazonTrackUrlParts | null
  productTitle: string | null
  asin: string | null
  quantity: number | null
  displayedItemPrice: ParsedMoney | null
  deliveryLocationText: string | null
  deliveredDateText: string | null
  shipmentStatus: "SHIPPED" | "DELAYED" | "DELIVERED" | null
}

export type EbaySaleParse = {
  type: "EBAY_SALE"
  ebayOrderId: string | null
  soldAmount: ParsedMoney | null
  dateSold: string | null
  buyerUsername: string | null
  quantity: number | null
  shipBy: string | null
  itemTitle: string | null
  shippingRecipient: string | null
  shippingAddress: string | null
}

export type EbayCancelParse = {
  type: "EBAY_CANCEL_REQUEST"
  ebayOrderId: string | null
  buyerId: string | null
  cancelId: string | null
  responseDeadline: string | null
  itemTitle: string | null
}

export type EbayCancelledParse = {
  type: "EBAY_CANCELLED"
  ebayOrderId: string | null
  cancelId: string | null
  itemTitle: string | null
}

export type EbayReturnParse = {
  type: "EBAY_RETURN_REQUEST"
  ebayOrderId: string | null
  buyerId: string | null
  returnId: string | null
  responseDeadline: string | null
  itemTitle: string | null
}

export type EbayPayoutParse = {
  type: "EBAY_PAYOUT"
  payoutId: string | null
  amount: ParsedMoney | null
  destination: string | null
  payoutType: string | null
  payoutDate: string | null
  estimatedArrival: string | null
}

export type MailboxParseResult =
  | AmazonEmailParse
  | EbaySaleParse
  | EbayCancelParse
  | EbayCancelledParse
  | EbayReturnParse
  | EbayPayoutParse

export type OrderProfitResult = {
  profit: number | null
  profitPercent: number | null
}

/** Order profit: remaining eBay earnings minus verified Amazon final total. */
export function orderProfitFromRemainingAndCost(input: {
  ebayRemainingEarnings: number | null
  amazonFinalCost: number | null
}): OrderProfitResult {
  if (input.ebayRemainingEarnings == null || input.amazonFinalCost == null) {
    return { profit: null, profitPercent: null }
  }
  const profit = roundMoney(input.ebayRemainingEarnings - input.amazonFinalCost)
  if (input.ebayRemainingEarnings === 0) {
    return { profit, profitPercent: null }
  }
  return {
    profit,
    profitPercent: roundMoney((profit / input.ebayRemainingEarnings) * 100),
  }
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

export const AMAZON_ORDER_NUMBER_RE = /\b(\d{3}-\d{7}-\d{7})\b/
export const EBAY_ORDER_NUMBER_RE = /\b(\d{2}-\d{5,8}-\d{4,8})\b/
export const ASIN_DP_RE = /amazon\.com\/(?:[^/\s]+\/)?dp\/([A-Z0-9]{10})/i
