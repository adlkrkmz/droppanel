export type Sync30dClicksRequest = {
  storeCode: string
}

export type Sync30dClicksResponse = {
  ok: boolean
  storeCode: string
  checked: number
  updated: number
  missingAnalyticsPermission: boolean
  message: string
  /** Set when DB scope includes analytics but the Analytics API call failed for another reason. */
  analyticsApiError?: string | null
}
