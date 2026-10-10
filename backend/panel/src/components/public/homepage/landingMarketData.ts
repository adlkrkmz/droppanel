/**
 * PLACEHOLDER / DEMO landing-page data only.
 * Not live eBay market data. Not backend-backed. No polling.
 * Replace this object later when admin/API binding exists.
 */

export type DemandLevel = "high" | "mid" | "low"

export type LandingCategory = {
  id: "motors" | "electronics" | "home" | "fashion" | "collectibles"
  name: string
  salesVolume: string
  growthPercent: number
  demandLevel: DemandLevel
}

export type LandingStat = {
  id: string
  label: string
  value: string
  delta: string
}

/** Placeholder market figures for visual landing only. */
export const landingMarketData: {
  updatedAt: string | null
  categories: LandingCategory[]
} = {
  updatedAt: null,
  categories: [
    { id: "motors", name: "Motors", salesVolume: "$2.22M", growthPercent: 16.1, demandLevel: "high" },
    { id: "electronics", name: "Electronics", salesVolume: "$2.48M", growthPercent: 18.6, demandLevel: "high" },
    { id: "fashion", name: "Fashion", salesVolume: "$1.36M", growthPercent: 14.7, demandLevel: "high" },
    { id: "home", name: "Home", salesVolume: "$1.75M", growthPercent: 9.3, demandLevel: "mid" },
    { id: "collectibles", name: "Collectibles", salesVolume: "$1.13M", growthPercent: 12.4, demandLevel: "mid" },
  ],
}

/** Placeholder KPI strip values for visual landing only. */
export const landingStats: LandingStat[] = [
  { id: "gmv", label: "Toplam satış hacmi", value: "$8.94M", delta: "örnek slot" },
  { id: "active", label: "Aktif ürün", value: "32,875", delta: "örnek slot" },
  { id: "orders30", label: "Sipariş (30 gün)", value: "1,482", delta: "örnek slot" },
  { id: "health", label: "Hesap sağlığı", value: "98.6%", delta: "örnek slot" },
]

export const DEMAND_LABEL: Record<DemandLevel, string> = {
  high: "Yüksek",
  mid: "Orta",
  low: "Düşük",
}

export const LANDING_FEATURES = [
  {
    title: "Toplu işlemler",
    body: "İlanları toplu güncelle, senkronize et ve yönet.",
  },
  {
    title: "Akıllı fiyatlama",
    body: "Kaynak ve eBay fiyatını aynı operasyon akışında tut.",
  },
  {
    title: "Ürün keşfi",
    body: "Kategori ve talep sinyalleriyle ürün keşfini destekle.",
  },
  {
    title: "Stok & sipariş sync",
    body: "Stok ve sipariş durumunu mağazalar arasında izle.",
  },
  {
    title: "Detaylı raporlar",
    body: "Satış, tıklama ve operasyon özetlerini tek yerde gör.",
  },
] as const

import heroArtwork from "../../../../public/listjetgo-hero-market-map.jpg"

export const HERO_ARTWORK_SRC = heroArtwork.src
export const HERO_ARTWORK_WIDTH = heroArtwork.width
export const HERO_ARTWORK_HEIGHT = heroArtwork.height
