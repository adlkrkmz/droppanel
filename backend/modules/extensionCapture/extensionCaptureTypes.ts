// ----------------------------------------------------------------
// extensionCaptureTypes.ts
// ----------------------------------------------------------------

export type ExtensionCaptureOperationType = "bulk_direct_list" | "bulk_add_to_pool"

export type ExtensionCaptureCommandStatus =
  | "queued"
  | "capturing"
  | "captured"
  | "publishing"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused"

export type ExtensionCaptureItemStatus =
  | "capture_pending"
  | "capturing"
  | "captured"
  | "extract_failed"
  | "capture_blocked"
  | "queued_for_publish"
  | "queued_for_pool"
  | "added_to_pool"
  | "published"
  | "skipped_duplicate"
  | "skipped_not_prime"
  | "skipped_out_of_stock"
  | "failed"

export type ExtensionCaptureItemInput = {
  asin:   string
  poolId?: number
}

export type CreateExtensionCaptureRequest = {
  operationType:    ExtensionCaptureOperationType
  storeCode:        string
  /** Preferred when provided; avoids ambiguous storeCode within a workspace. */
  storeId?:         number
  asins?:           string[]
  items?:           ExtensionCaptureItemInput[]
  titleMode?:       string
  quantity?:        number
  delaySec?:        number
  publishCommandId?: number
  publishJobSeq?:   number
  metadata?:        Record<string, unknown>
  promotedEnabled?: boolean
  promotedAdRate?:  number | string | null
}

export type ExtensionCaptureItemSummary = {
  itemId:    number
  asin:      string
  amazonUrl: string
  status:    ExtensionCaptureItemStatus
  poolId?:   number | null
  errorMessage?: string | null
  ok?:            boolean
  code?:          string
  message?:       string
  retryable?:     boolean
  jobId?:         number | null
  listingId?:     string | null
  alreadyExists?: boolean
  promotion?: {
    requested: boolean
    requestedRate: number | null
    status: string
    effectiveRate: number | null
    campaignId: string | null
    adId: string | null
    code: string | null
    message: string
    retryable: boolean
  } | null
}

export type CreateExtensionCaptureResponse = {
  ok:        true
  commandId: number
  items:     ExtensionCaptureItemSummary[]
}

export type ExtensionCaptureCommandDetail = {
  id:               number
  storeCode:        string
  operationType:    ExtensionCaptureOperationType
  titleMode:        string
  quantity:         number
  delaySec:         number
  status:           ExtensionCaptureCommandStatus
  totalCount:       number
  capturedCount:    number
  failedCount:      number
  publishedCount:   number
  addedCount:       number
  skippedCount:     number
  publishCommandId: number | null
  metadata:         Record<string, unknown>
  createdAt:        string
  updatedAt:        string
  completedAt:      string | null
  items:            ExtensionCaptureItemSummary[]
}

export type SubmitCapturePayloadRequest = {
  asin:           string
  capturePayload: Record<string, unknown>
}

export type SubmitCapturePayloadResponse = {
  ok:               true
  itemId:           number
  asin:             string
  status:           ExtensionCaptureItemStatus
  poolId:           number | null
  publishCommandId: number | null
  publishJobId:     number | null
  alreadyCaptured?: boolean
}

export type ClaimNextCaptureItem = {
  commandId:     number
  itemId:        number
  asin:          string
  amazonUrl:     string
  operationType: ExtensionCaptureOperationType
  storeCode:     string
  titleMode:     string
  quantity:      number
  delaySec:      number
  poolId:        number | null
}

export type ClaimNextCaptureResponse = {
  ok:      true
  item?:   ClaimNextCaptureItem
  message: string
}

export type FailCaptureItemRequest = {
  errorCode?:    string
  errorMessage:  string
  retryable?:    boolean
}

export type FailCaptureItemResponse = {
  ok:     true
  itemId: number
  status: ExtensionCaptureItemStatus
}
