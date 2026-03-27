// ─────────────────────────────────────────────────────────────
// lib/mockData.ts
// Mock veri — backend endpointleri hazır olduğunda
// bu dosyadaki fonksiyonlar API çağrılarıyla değiştirilir.
// ─────────────────────────────────────────────────────────────

export type DashboardSummary = {
  asinRegistryTotal:  number
  asinPoolTotal:      number
  poolReady:          number
  poolCompleted:      number
  pipelineStages: {
    validated:    number
    scraped:      number
    ai_generated: number
    listed:       number
  }
  storesTotal:  number
  storesActive: number
  generatedAt:  string
}

export type QueueSummary = {
  scrapeQueueCount:  number
  aiQueueCount:      number
  publishQueueCount: number
  total:             number
  generatedAt:       string
}

export type ListingHistoryRow = {
  id:          number
  asin:        string
  internalSku: string | null
  ebayItemId:  string | null
  storeName:   string | null
  status:      string
  listedAt:    string | null
  createdAt:   string
}

export type StoreRow = {
  id:        number
  name:      string
  storeCode: string
  status:    string
  createdAt: string
}

// ─── MOCK ─────────────────────────────────────────────────────

export async function fetchDashboard(): Promise<DashboardSummary> {
  // TODO: return fetch('/api/admin/summary').then(r => r.json())
  return {
    asinRegistryTotal: 348,
    asinPoolTotal:     312,
    poolReady:         187,
    poolCompleted:     125,
    pipelineStages: {
      validated:    42,
      scraped:      68,
      ai_generated: 55,
      listed:       125,
    },
    storesTotal:  4,
    storesActive: 3,
    generatedAt:  new Date().toISOString(),
  }
}

export async function fetchQueue(): Promise<QueueSummary> {
  // TODO: return fetch('/api/admin/queue').then(r => r.json())
  return {
    scrapeQueueCount:  42,
    aiQueueCount:      68,
    publishQueueCount: 55,
    total:             165,
    generatedAt:       new Date().toISOString(),
  }
}

export async function fetchHistory(): Promise<ListingHistoryRow[]> {
  // TODO: return fetch('/api/admin/history').then(r => r.json()).then(r => r.rows)
  const statuses = ["success", "success", "success", "failed", "success"]
  return Array.from({ length: 18 }, (_, i) => ({
    id:          1000 + i,
    asin:        `B0${String(i + 1).padStart(9, "C")}`,
    internalSku: `DP-B0${String(i + 1).padStart(9, "C")}-STR01`,
    ebayItemId:  `2846${String(i * 7 + 3).padStart(10, "0")}`,
    storeName:   i % 3 === 0 ? "Store Alpha" : i % 3 === 1 ? "Store Beta" : "Store Gamma",
    status:      statuses[i % statuses.length],
    listedAt:    new Date(Date.now() - i * 3_600_000).toISOString(),
    createdAt:   new Date(Date.now() - i * 3_700_000).toISOString(),
  }))
}

export async function fetchStores(): Promise<StoreRow[]> {
  // TODO: return fetch('/api/admin/stores').then(r => r.json()).then(r => r.rows)
  return [
    { id: 1, name: "Store Alpha",   storeCode: "STR01", status: "active",   createdAt: "2025-01-10T00:00:00Z" },
    { id: 2, name: "Store Beta",    storeCode: "STR02", status: "active",   createdAt: "2025-02-14T00:00:00Z" },
    { id: 3, name: "Store Gamma",   storeCode: "STR03", status: "active",   createdAt: "2025-03-01T00:00:00Z" },
    { id: 4, name: "Store Delta",   storeCode: "STR04", status: "inactive", createdAt: "2025-04-20T00:00:00Z" },
  ]
}
