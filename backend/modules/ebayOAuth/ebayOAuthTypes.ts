// ─────────────────────────────────────────────────────────────
// ebayOAuthTypes.ts
// ─────────────────────────────────────────────────────────────

export type EbayAccountRow = {
  id:           number
  workspaceId:  string
  storeId:      number
  storeCode:    string
  ebayUserId:   string | null
  accessToken:  string | null
  refreshToken: string | null
  expiresAt:    string | null
  scope:        string | null
  connected:    boolean
  createdAt:    string
  updatedAt:    string
}

export type EbayConnectUrlResponse = {
  storeCode:   string
  authUrl:     string
  state:       string
}

export type EbayCallbackResult = {
  storeCode:    string
  ebayUserId:   string | null
  accessToken:  string
  refreshToken: string
  expiresAt:    string
  scope:        string
  success:      boolean
}

export type EbayAccountStatus = {
  storeCode:   string
  storeName:   string
  connected:   boolean
  ebayUserId:  string | null
  expiresAt:   string | null
  expiresIn:   number | null   // seconds
  expired:     boolean
  scope:       string | null
}

export type EbayTokenRefreshResult = {
  accessToken:  string
  refreshToken: string
  expiresAt:    string
}
