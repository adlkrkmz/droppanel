// ----------------------------------------------------------------
// ordersTypes.ts — DB-backed order operation screen types
// ----------------------------------------------------------------

export type OrderStatusBadge = "new" | "processing" | "updated" | "error"

// Local dropshipping operation status — independent of eBay fulfillment status.
export const OPERATION_STATUSES = [
  "NEW_ORDER",
  "AMAZON_PENDING",
  "AMAZON_ORDERED",
  "AQUALINE_PENDING",
  "TRACKING_PENDING",
  "TRACKING_RECEIVED",
  "EBAY_TRACKING_SUBMITTED",
  "IN_TRANSIT",
  "DELIVERED",
  "PROBLEM",
  "CANCELLED_REFUNDED",
] as const

export type OperationStatus = (typeof OPERATION_STATUSES)[number]

export const OPERATION_STATUS_LABELS: Record<OperationStatus, string> = {
  NEW_ORDER:               "Yeni Sipariş",
  AMAZON_PENDING:          "Amazon Bekliyor",
  AMAZON_ORDERED:          "Amazon Girildi",
  AQUALINE_PENDING:        "Aqualine Bekliyor",
  TRACKING_PENDING:        "Tracking Bekliyor",
  TRACKING_RECEIVED:       "Tracking Alındı",
  EBAY_TRACKING_SUBMITTED: "eBay'e Tracking Basıldı",
  IN_TRANSIT:              "Yolda",
  DELIVERED:               "Teslim Edildi",
  PROBLEM:                 "Sorunlu",
  CANCELLED_REFUNDED:      "İptal / Refund",
}

export const DEFAULT_OPERATION_STATUS: OperationStatus = "AMAZON_PENDING"

export function isOperationStatus(v: unknown): v is OperationStatus {
  return typeof v === "string" && (OPERATION_STATUSES as readonly string[]).includes(v)
}

export function operationStatusLabel(status: OperationStatus): string {
  return OPERATION_STATUS_LABELS[status] ?? status
}

export type OrderListItem = {
  id:            number
  orderId:       string
  storeCode:     string
  storeName:     string
  creationDate:  string | null
  buyerUsername: string | null
  buyerName:     string | null
  productTitle:  string
  imageUrl:      string | null
  quantity:      number
  total:         number
  currency:      string
  status:        OrderStatusBadge
  operationStatus:      OperationStatus
  operationStatusLabel: string
}

export type OrderAddress = {
  name:         string | null
  addressLine1: string | null
  addressLine2: string | null
  city:         string | null
  state:        string | null
  postalCode:   string | null
  country:      string | null
  phone:            string | null  // legacy: same as phoneRaw (back-compat)
  phoneRaw:         string | null  // original eBay value, untouched
  phoneDisplay:     string | null  // panel display + copy (country-coded)
  phoneAmazonInput: string | null  // clean digits for Amazon form input
}

export type OrderDetailItem = {
  title:       string
  imageUrl:    string | null
  ebayItemId:  string | null
  asin:        string | null
  sku:         string | null
  quantity:    number
  itemPrice:   number | null
  currency:    string | null
}

export type OrderManualFields = {
  notes:               string | null
  amazonOrderNumber:   string | null
  amazonOrderUrl:      string | null
  amazonPurchasePrice: number | null
}

/** eBay Seller Hub "Order earnings" — not buyer paid / order total. */
export type OrderFinanceSummary = {
  ebayOrderEarnings:          number | null
  ebayOrderEarningsCurrency:  string | null
  ebayOrderEarningsSource:    string | null
  ebayOrderEarningsCheckedAt: string | null
  ebayOrderEarningsError:     string | null
  status: "available" | "missing" | "not_ready" | "error"
  ebayGrossSales:             number | null
  amazonFinalCost:            number | null
  profit:                     number | null
  profitPercent:              number | null
}

export type OrderTrackingInfo = {
  ebayTrackingNumber: string | null
  ebayCarrier: string | null
  ebayShipmentStatus: string | null
  ebayShippedAt: string | null
  amazonTrackingUrl: string | null
  amazonShipmentId: string | null
  amazonPackageIndex: string | null
  amazonEstimatedDelivery: string | null
  amazonDeliveryStatus: string | null
  amazonDeliveryLocation: string | null
  amazonDeliveredAt: string | null
}

export type OrderEvent = {
  type:      string
  message:   string | null
  createdAt: string
}

export type OrderDetail = {
  id:                number
  ebayOrderId:       string
  legacyOrderId:     string | null
  storeCode:         string
  storeName:         string
  creationDate:      string | null
  lastSyncedAt:      string | null
  status:            OrderStatusBadge
  fulfillmentStatus: string | null
  paymentStatus:     string | null
  operationStatus:          OperationStatus
  operationStatusLabel:     string
  operationStatusUpdatedAt: string | null
  buyerUsername:     string | null
  buyerName:         string | null
  total:             number
  currency:          string
  items:             OrderDetailItem[]
  address:           OrderAddress | null
  manual:            OrderManualFields
  finance:           OrderFinanceSummary
  tracking:          OrderTrackingInfo
  events:            OrderEvent[]
}

export type OrderManualUpdateInput = {
  notes?:               string | null
  amazonOrderNumber?:   string | null
  amazonOrderUrl?:      string | null
  amazonPurchasePrice?: number | null
  operationStatus?:     OperationStatus
}

export type OrdersStoreError = {
  storeCode: string
  storeName: string
  message:   string
}

export type OrdersListResponse = {
  ok:        true
  allStores: boolean
  storeCode: string | null
  orders:    OrderListItem[]
  errors:    OrdersStoreError[]
}

export type OrdersSyncStoreResult = {
  storeCode:      string
  storeName:      string
  fetched:        number
  upsertedOrders: number
  upsertedItems:  number
}

// Assisted Amazon order packet — read-only snapshot handed to the extension.
export type AssistedOrderPacket = {
  orderId:          number
  ebayOrderId:      string
  storeCode:        string
  title:            string
  imageUrl:         string | null
  asin:             string
  sku:              string | null
  ebayItemId:       string | null
  quantity:         number
  amazonProductUrl: string
  buyerUsername:    string | null
  buyerName:        string | null
  shippingAddress:  OrderAddress | null
  phone:            string | null
  phoneRaw:         string | null
  phoneNormalized:  string | null  // alias of phoneDisplay (back-compat)
  phoneDisplay:     string | null
  phoneAmazonInput: string | null
  paidAmount:       number
  currency:         string
  autoRun:          boolean
}

export class OrdersHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = "OrdersHttpError"
  }
}
