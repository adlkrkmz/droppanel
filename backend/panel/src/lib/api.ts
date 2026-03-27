const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000"

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    cache: "no-store", headers: { "Content-Type": "application/json" }, ...init,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`API ${res.status} ${res.statusText}: ${path}${text ? ` — ${text}` : ""}`)
  }
  return res.json() as Promise<T>
}

export type DashboardSummary = {
  asinRegistryTotal: number; asinPoolTotal: number; poolReady: number; poolCompleted: number
  pipelineStages: { validated: number; scraped: number; ai_generated: number; listed: number }
  storesTotal: number; storesActive: number; generatedAt: string
}
export type QueueSummary = {
  scrapeQueueCount: number; aiQueueCount: number; publishQueueCount: number; total: number; generatedAt: string
}
export type ListingHistoryRow = {
  id: number; asin: string; internalSku: string | null; ebayItemId: string | null
  storeName: string | null; status: string; listedAt: string | null; createdAt: string
}
export type StoreRow = { id: number; name: string; storeCode: string; status: string; createdAt: string }

export type PoolRow = {
  poolId: number; asin: string; title: string | null; brand: string | null
  amazonCost: number | null; pipelineStage: string; status: string
  scrapeStatus: string; aiStatus: string; listingStatus: string
  assignedStoreId: number | null; assignedStoreCode: string | null
  assignedStoreName: string | null; updatedAt: string
}
export type PoolResult = {
  rows: PoolRow[]; total: number
  filters: { stage: string | null; status: string | null; storeCode: string | null }
  generatedAt: string
}
export type PoolDispatchRequest  = { storeCode: string; poolIds: number[]; delaySeconds?: number }
export type PoolDispatchResponse = { selectedCount: number; skippedCount: number; assignedPoolIds: number[] }

export type ListingRunRequest = {
  storeCode: string; count: number
  selectionMode: "random" | "priority" | "fifo"
  delaySeconds: number; quantity: number
  dryRun?: boolean; simulationMode?: boolean
}
export type ListingRunPublishItem = {
  poolId: number; asin: string; sku: string
  status: "success" | "failed" | "skipped" | "blocked"
  error: string | null; guardScore: number | null
  guardErrors: string[]; guardWarnings: string[]; durationMs: number
}
export type ListingRunResponse = {
  storeId: number; storeCode: string; storeName: string
  dryRun: boolean; simulationMode: boolean
  dispatch: { selectedCount: number; skippedCount: number; assignedPoolIds: number[]; assignedAsins: string[] }
  publish: {
    attempted: number; succeeded: number; failed: number; blocked: number; skipped: number
    items: ListingRunPublishItem[]; totalMs: number
  }
  startedAt: string; completedAt: string; totalMs: number
}

export type PublishItemResult = {
  poolId: number; asin: string; sku: string
  status: "success" | "failed" | "skipped" | "blocked"
  error: string | null; guardScore: number | null
  guardErrors: string[]; guardWarnings: string[]; durationMs: number
}

// ─── GET ──────────────────────────────────────────────────────

export async function getSummary() {
  return apiFetch<{ dashboard: DashboardSummary; runtime: { loopStatus: string; turn: number; startedAt: string|null; lastTurnAt: string|null; recentTurns: number } }>("/admin/summary")
}
export async function getQueue()  { return apiFetch<QueueSummary>("/admin/queue") }
export async function getHistory(limit = 50) {
  return apiFetch<{ rows: ListingHistoryRow[]; total: number; generatedAt: string }>(`/admin/history?limit=${limit}`)
}
export async function getStores() { return apiFetch<{ rows: StoreRow[]; total: number; generatedAt: string }>("/admin/stores") }
export async function getPool(params?: { stage?: string; status?: string; storeCode?: string; limit?: number }) {
  const q = new URLSearchParams()
  if (params?.stage)     q.set("stage",     params.stage)
  if (params?.status)    q.set("status",    params.status)
  if (params?.storeCode) q.set("storeCode", params.storeCode)
  if (params?.limit)     q.set("limit",     String(params.limit))
  return apiFetch<PoolResult>(`/admin/pool${q.toString() ? "?" + q.toString() : ""}`)
}

export type MonitorItem = {
  sku: string; title: string; image: string | null
  ebayPrice: number; quantity: number
  cost: number | null; margin: number | null
  asin: string | null; ebayItemId: string | null; listedAt: string | null
  status: "TRACKED" | "UNTRACKED"
  poolId: number | null; stage: string | null
}
export type MonitorResult = {
  store: string
  total: number
  ebayInventoryTotal: number
  tracked: number
  untracked: number
  simulationMode: boolean
  items: MonitorItem[]
  generatedAt: string
  currentPage: number
  totalPages: number
}

// ─── POST ─────────────────────────────────────────────────────

export async function postMonitorUpdatePrice(storeCode: string, sku: string, newPrice: number): Promise<{ success: boolean; simulation: boolean; newPrice: number; message: string }> {
  return apiFetch("/admin/monitor/update-price", { method: "POST", body: JSON.stringify({ storeCode, sku, newPrice }) })
}
export async function postMonitorUpdateStock(storeCode: string, sku: string, quantity: number): Promise<{ success: boolean; simulation: boolean; quantity: number; message: string }> {
  return apiFetch("/admin/monitor/update-stock", { method: "POST", body: JSON.stringify({ storeCode, sku, quantity }) })
}
export async function postMonitorBlind(storeCode: string, sku: string): Promise<{ success: boolean; simulation: boolean; message: string }> {
  return apiFetch("/admin/monitor/blind", { method: "POST", body: JSON.stringify({ storeCode, sku }) })
}
export async function getMonitorListings(
  storeCode = "S1",
  params?: { offset?: number; limit?: number }
): Promise<MonitorResult> {
  const q = new URLSearchParams({ storeCode })
  if (params?.offset !== undefined) q.set("offset", String(params.offset))
  if (params?.limit !== undefined) q.set("limit", String(params.limit))
  return apiFetch<MonitorResult>(`/admin/monitor/listings?${q.toString()}`)
}
export async function postPoolDispatch(req: PoolDispatchRequest): Promise<PoolDispatchResponse> {
  return apiFetch<PoolDispatchResponse>("/admin/pool/dispatch-selected", { method: "POST", body: JSON.stringify(req) })
}
export async function postListingRun(req: ListingRunRequest): Promise<ListingRunResponse> {
  return apiFetch<ListingRunResponse>("/admin/listing/run", { method: "POST", body: JSON.stringify(req) })
}

export async function deletePoolItems(poolIds: number[]): Promise<{ deleted: number }> {
  return apiFetch<{ deleted: number }>("/admin/pool", { method: "DELETE", body: JSON.stringify({ poolIds }) })
}

export async function createDispatchRun(params: {
  storeCode: string
  poolIds: number[]
  quantity: number
  delaySeconds: number
}): Promise<any> {
  return apiFetch<any>("/admin/dispatch-runs/create", { method: "POST", body: JSON.stringify(params) })
}

export async function getActiveRuns(): Promise<any> {
  return apiFetch<any>("/admin/dispatch-runs/active")
}

export async function getRunStatus(runId: number): Promise<any> {
  return apiFetch<any>(`/admin/dispatch-runs/status?runId=${runId}`)
}
