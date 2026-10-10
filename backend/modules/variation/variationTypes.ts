export type VariationSource = 'amazon'

export type VariationItemInput = {
  sku?:         string
  aspectName:   string
  aspectValue:  string
  price:        number
  quantity:     number
  images:       string[]
}

export type VariationCaptureData = {
  source:     VariationSource
  asin:       string
  title:      string
  brand:      string
  images:     string[]
  videoUrl:   string | null
  variations: VariationItemInput[]
  storeCode:  string
  markupPct:  number
}

export type VariationProductRow = {
  id:          number
  workspaceId: string
  asin:        string
  source:      string
  title:       string | null
  brand:       string | null
  images:      string[]
  videoUrl:    string | null
  videoR2Url:  string | null
  category:    string | null
  storeCode:   string | null
  status:      string
  ebayItemId:  string | null
}

export type VariationItemRow = {
  id:                 number
  variationProductId: number
  sku:                string
  aspectName:         string
  aspectValue:        string
  price:              number
  quantity:           number
  images:             string[]
  ebayOfferId:        string | null
  status:             string
}
