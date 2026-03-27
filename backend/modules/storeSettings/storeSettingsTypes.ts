// ----------------------------------------------------------------
// storeSettingsTypes.ts
// store_settings tablosu (policies, merchant_location_key, adres, fiyatlandirma).
// ----------------------------------------------------------------

export type StoreAddress = {
  firstName:  string
  lastName:   string
  company:    string | null
  address1:   string
  address2:   string | null
  city:       string
  state:      string
  zip:        string
  country:    string
}

export type StoreSettingsRow = {
  id:                    number
  workspaceId:           string
  storeId:               number
  markupPercent:         number
  profitMarginPercent:   number
  taxEstimatePercent:    number
  ebayFeePercent:        number
  defaultQuantity:       number
  templateId:            string | null
  merchantLocationKey:   string | null
  paymentPolicyId:       string | null
  returnPolicyId:        string | null
  fulfillmentPolicyId:   string | null
  intervalMinutes:       number
  enabled:               boolean
  createdAt:             string
  updatedAt:             string
  addressFirstName:      string | null
  addressLastName:       string | null
  addressCompany:        string | null
  addressLine1:          string | null
  addressLine2:          string | null
  addressCity:           string | null
  addressState:          string | null
  addressZip:            string | null
  addressCountry:        string | null
  /** Registration / overseas policy market (US, UK, DE, …) */
  registrationCountry:   string | null
}

export type CreateStoreSettingsInput = {
  workspaceId:           string
  storeId:               number
  markupPercent?:        number
  profitMarginPercent?:  number
  taxEstimatePercent?:   number
  ebayFeePercent?:       number
  defaultQuantity?:      number
  templateId?:           string | null
  merchantLocationKey?:  string | null
  paymentPolicyId?:      string | null
  returnPolicyId?:       string | null
  fulfillmentPolicyId?:  string | null
  intervalMinutes?:      number
  enabled?:              boolean
  addressFirstName?:     string | null
  addressLastName?:      string | null
  addressCompany?:       string | null
  addressLine1?:         string | null
  addressLine2?:         string | null
  addressCity?:          string | null
  addressState?:         string | null
  addressZip?:           string | null
  addressCountry?:       string | null
  registrationCountry?:  string | null
}

export type UpdateStoreSettingsInput = Partial<Omit<
  CreateStoreSettingsInput,
  "workspaceId" | "storeId"
>>

export type ValidationResult = {
  valid:    boolean
  errors:   string[]
  warnings: string[]
}

export type ResolvedStoreSettings = StoreSettingsRow & {
  storeName: string
  storeCode: string
}
