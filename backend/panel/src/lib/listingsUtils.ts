import type { MonitorItem } from "@/lib/api"
import { formatSourceStatusReasonForUi, isUiTurkish } from "./sourceStatusDisplay"

export type SourceStatusKey =
  | "amazon_ok"
  | "unavailable"
  | "no_price"
  | "removed"
  | "price_increase"
  | "price_uncertain"
  | "check_failed"
  | "no_asin"
  | "bot_zeroed"

export type SourceStatusInfo = {
  key: SourceStatusKey
  label: string
  reason: string
}

export type StatusFilter =
  | "all"
  | "active"
  | "qty0"
  | "bot_zeroed"
  | "amazon_unavailable"
  | "no_price"
  | "check_failed"
  | "no_asin"
  | "guard_on"
  | "guard_off"

export type SortColumn =
  | "title"
  | "asin"
  | "ebay_item_id"
  | "quantity"
  | "price"
  | "amazon_price"
  | "source_status"
  | "upload_date"
  | "total_sold"
  | "clicks_30d"

export type SortDir = "asc" | "desc"

/** First click sort direction per column */
export const DEFAULT_SORT_DIR: Record<SortColumn, SortDir> = {
  title: "asc",
  asin: "asc",
  ebay_item_id: "asc",
  quantity: "desc",
  price: "desc",
  amazon_price: "desc",
  source_status: "asc",
  upload_date: "desc",
  total_sold: "desc",
  clicks_30d: "desc",
}

export type SortState = { col: SortColumn | null; dir: SortDir }

export function nextSortState(prev: SortState, col: SortColumn): SortState {
  if (prev.col === col) {
    return { col, dir: prev.dir === "asc" ? "desc" : "asc" }
  }
  return { col, dir: DEFAULT_SORT_DIR[col] }
}

/** Coerce DB/API values to finite numbers for sorting (nulls last). */
export function toSortNumber(value: unknown): number | null {
  if (value == null || value === "") return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  const s = String(value).trim()
  if (!s || s === "—" || s === "-") return null
  const n = Number(s.replace(/[^0-9.-]/g, ""))
  return Number.isFinite(n) ? n : null
}

/** Frontend column key → backend sortBy param */
export const SORT_COLUMN_TO_API: Record<SortColumn, string> = {
  title: "title",
  asin: "asin",
  ebay_item_id: "ebayItemId",
  quantity: "quantity",
  price: "ebayPrice",
  amazon_price: "sourcePrice",
  source_status: "sourceStatus",
  upload_date: "listedAt",
  total_sold: "totalSold",
  clicks_30d: "clicks30d",
}

const ASIN_REGEX = /^[A-Z0-9]{10}$/

export function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n)
}

export function hasValidPrice(item: MonitorItem): boolean {
  return isFiniteNum(item.ebayPrice) && item.ebayPrice > 0
}

export function isCheckFailed(item: MonitorItem): boolean {
  if (!Number.isFinite(item.quantity)) return true
  if (!hasValidPrice(item)) return false
  if (item.isTracked && !item.ebayItemId?.trim()) return true
  return false
}

const DB_STATUS_LABELS: Record<string, { key: SourceStatusKey; label: string }> = {
  AMAZON_OK:     { key: "amazon_ok",     label: "Amazon OK" },
  UNAVAILABLE:   { key: "unavailable",   label: "Unavailable" },
  NO_PRICE:      { key: "no_price",      label: "No Price" },
  REMOVED:       { key: "removed",       label: "Removed" },
  PRICE_INCREASE: { key: "price_increase", label: "Price Increase" },
  PRICE_UNCERTAIN: { key: "price_uncertain", label: "Price Uncertain" },
  CHECK_FAILED:  { key: "check_failed",  label: "Check Failed" },
  NO_ASIN:       { key: "no_asin",       label: "No ASIN" },
  BOT_ZEROED:    { key: "bot_zeroed",    label: "Bot Zeroed" },
}

function fromDbSourceStatus(
  status: string | null | undefined,
  reason: string | null | undefined
): SourceStatusInfo | null {
  const raw = status?.trim().toUpperCase()
  if (!raw) return null
  const mapped = DB_STATUS_LABELS[raw]
  if (!mapped) return null
  const displayReason = formatSourceStatusReasonForUi(raw, reason)
  return {
    key: mapped.key,
    label: mapped.label,
    reason: displayReason === "—" ? "" : displayReason,
  }
}

export function deriveSourceStatus(item: MonitorItem): SourceStatusInfo {
  const fromDb = fromDbSourceStatus(item.sourceStatus, item.sourceStatusReason)
  if (fromDb) return fromDb

  const status = (item.currentStatus ?? "").toLowerCase()

  if (status === "ended") {
    return { key: "removed", label: "Removed", reason: "liste kaldırılmış" }
  }
  if (!item.asin?.trim()) {
    return { key: "no_asin", label: "No ASIN", reason: "ASIN eksik" }
  }
  if (!hasValidPrice(item)) {
    return { key: "no_price", label: "No Price", reason: "fiyat yok" }
  }
  if (item.quantity === 0 && item.botZeroedAt) {
    return {
      key: "bot_zeroed",
      label: "Bot Zeroed",
      reason: item.botZeroedReason?.trim() || "stok sıfırlandı",
    }
  }
  if (isCheckFailed(item)) {
    const reason = formatSourceStatusReasonForUi("CHECK_FAILED", item.sourceStatusReason)
    return {
      key: "check_failed",
      label: "Check Failed",
      reason: reason === "—" ? "" : reason,
    }
  }
  if (item.asin && !item.sourceUrl?.trim()) {
    return { key: "unavailable", label: "Unavailable", reason: "kaynak bulunamadı" }
  }
  return { key: "amazon_ok", label: "Amazon OK", reason: "" }
}

const STATUS_PRIORITY: Record<SourceStatusKey, number> = {
  bot_zeroed: 0,
  unavailable: 1,
  no_price: 2,
  price_increase: 2,
  price_uncertain: 2,
  removed: 3,
  check_failed: 4,
  no_asin: 5,
  amazon_ok: 6,
}

export function defaultStatusSort(a: MonitorItem, b: MonitorItem): number {
  const pa = STATUS_PRIORITY[deriveSourceStatus(a).key]
  const pb = STATUS_PRIORITY[deriveSourceStatus(b).key]
  if (pa !== pb) return pa - pb
  if (a.quantity === 0 && b.quantity !== 0) return -1
  if (b.quantity === 0 && a.quantity !== 0) return 1
  return a.sku.localeCompare(b.sku)
}

export function passesStatusFilter(item: MonitorItem, filter: StatusFilter): boolean {
  const src = deriveSourceStatus(item)
  switch (filter) {
    case "all":
      return true
    case "active":
      return item.quantity > 0 && !item.panelHiddenAt
    case "qty0":
      return item.quantity === 0
    case "bot_zeroed":
      return src.key === "bot_zeroed" || Boolean(item.botZeroedAt)
    case "amazon_unavailable":
      return src.key === "unavailable"
    case "no_price":
      return src.key === "no_price"
    case "check_failed":
      return src.key === "check_failed"
    case "no_asin":
      return src.key === "no_asin"
    case "guard_on":
      return item.stockGuardEnabled !== false
    case "guard_off":
      return item.stockGuardEnabled === false
    default:
      return true
  }
}

export function getAmazonUrl(item: MonitorItem): string | null {
  if (item.sourceUrl?.trim()) return item.sourceUrl.trim()
  const asin = item.asin?.trim()
  if (!asin) return null
  if (asin.startsWith("DPALI") || asin.startsWith("ALI")) {
    const numericPart = asin.replace(/^(DPALI|ALI)/, "")
    const cleanId = numericPart.replace(/S\d+$/, "")
    return `https://www.aliexpress.com/item/${cleanId}.html`
  }
  if (asin.startsWith("DPTEMU") || asin.startsWith("TEMU")) {
    const numericPart = asin.replace(/^(DPTEMU|TEMU)/, "")
    const cleanId = numericPart.replace(/S\d+$/, "")
    return `https://www.temu.com/goods.html?goods_id=${cleanId}`
  }
  if (ASIN_REGEX.test(asin)) {
    return `https://www.amazon.com/dp/${asin}`
  }
  return null
}

export function getEbayUrl(item: MonitorItem): string | null {
  const id = item.ebayItemId?.trim()
  if (!id) return null
  return `https://www.ebay.com/itm/${id}`
}

export function formatPrice(item: MonitorItem): string {
  if (!hasValidPrice(item)) return "—"
  return `$${item.ebayPrice.toFixed(2)}`
}

export function ebayPriceTooltip(item: MonitorItem): string | undefined {
  if (item.autoPriceProtectedAt?.trim()) {
    return isUiTurkish() ? "Kâr otomatik korundu" : "Profit auto-protected"
  }
  return undefined
}

export function formatAmazonPrice(item: MonitorItem): string {
  const n = item.sourcePrice
  if (n == null || !Number.isFinite(n)) return "—"
  return `$${n.toFixed(2)}`
}

export function formatSourceCheckedAgo(iso: string | null | undefined): string {
  if (!iso?.trim()) return ""
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return ""
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return "checked just now"
  if (h < 24) return `checked ${h}h ago`
  const d = Math.floor(h / 24)
  return `checked ${d}d ago`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso?.trim()) return "—"
  const x = Date.parse(iso)
  if (!Number.isFinite(x)) return "—"
  try {
    return new Date(x).toLocaleDateString(undefined, { dateStyle: "medium" })
  } catch {
    return "—"
  }
}

export function formatMetricNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return String(n)
}

/** Sold / 30D Clicks: null, empty, or "—" → 0 for display and sort. */
export function coalesceSoldOrClicks(value: unknown): number {
  const n = toSortNumber(value)
  return n == null ? 0 : n
}

export function formatSoldCount(n: number | null | undefined): string {
  return String(coalesceSoldOrClicks(n))
}

function cmpNumCoalesceZeroDir(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: SortDir
): number {
  const aNum = coalesceSoldOrClicks(a)
  const bNum = coalesceSoldOrClicks(b)
  return dir === "desc" ? bNum - aNum : aNum - bNum
}

export const CLICKS_UNAVAILABLE_TOOLTIP =
  "30-day listing views are not available — reconnect the store with eBay Analytics permission (sell.analytics.readonly)."

export function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso?.trim()) return null
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return null
  const diffMs = Date.now() - then
  if (diffMs < 0) return "just now"
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function formatClicksCell(item: MonitorItem): {
  display: string
  sub?: string
  title?: string
} {
  const clicks = coalesceSoldOrClicks(item.clicks30d)
  const checked = formatRelativeTime(item.clicks30dCheckedAt ?? item.metricsSyncedAt)
  let title: string | undefined
  if (item.metricsError?.toLowerCase().includes("analytics")) {
    title = CLICKS_UNAVAILABLE_TOOLTIP
  } else if (clicks === 0 && !checked) {
    title =
      "Not synced yet — updates automatically every 24h when Analytics permission is active"
  }
  return {
    display: String(clicks),
    sub: checked ? `checked ${checked}` : undefined,
    title,
  }
}

export function formatWatchViewsCell(item: MonitorItem): { primary: string; secondary?: string } {
  const watch = item.watchCount
  const views = item.views30d
  if (watch != null && Number.isFinite(watch)) {
    if (views != null && Number.isFinite(views)) {
      return { primary: `Watch: ${watch}`, secondary: `Views: ${views}` }
    }
    return { primary: `Watch: ${watch}` }
  }
  if (views != null && Number.isFinite(views)) {
    return { primary: `Views: ${views}` }
  }
  return { primary: "—" }
}

function watchOrViewsSortKey(item: MonitorItem): number | null {
  const watch = toSortNumber(item.watchCount)
  if (watch != null) return watch
  return toSortNumber(item.views30d)
}

export function sortPageItems(
  items: MonitorItem[],
  col: SortColumn,
  dir: SortDir
): MonitorItem[] {
  return [...items].sort((a, b) => compareColumn(a, b, col, dir))
}

/** Null/missing always last; direction applies only to numeric values (0 is valid). */
export function cmpNumNullsLastDir(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: SortDir
): number {
  const aNum = toSortNumber(a)
  const bNum = toSortNumber(b)
  const aNull = aNum == null
  const bNull = bNum == null
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  return dir === "desc" ? bNum - aNum : aNum - bNum
}

function cmpStrNullsLastDir(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: SortDir
): number {
  const aNull = !a?.trim()
  const bNull = !b?.trim()
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  const cmp = a!.localeCompare(b!, undefined, { sensitivity: "base" })
  return dir === "desc" ? -cmp : cmp
}

export function compareColumn(
  a: MonitorItem,
  b: MonitorItem,
  col: SortColumn,
  dir: SortDir
): number {
  switch (col) {
    case "title":
      return cmpStrNullsLastDir(a.title, b.title, dir)
    case "asin":
      return cmpStrNullsLastDir(a.asin, b.asin, dir)
    case "ebay_item_id":
      return cmpStrNullsLastDir(a.ebayItemId, b.ebayItemId, dir)
    case "quantity":
      return cmpNumNullsLastDir(a.quantity, b.quantity, dir)
    case "price":
      return cmpNumNullsLastDir(
        hasValidPrice(a) ? a.ebayPrice : null,
        hasValidPrice(b) ? b.ebayPrice : null,
        dir
      )
    case "amazon_price":
      return cmpNumNullsLastDir(a.sourcePrice, b.sourcePrice, dir)
    case "source_status": {
      const cmp =
        STATUS_PRIORITY[deriveSourceStatus(a).key] -
        STATUS_PRIORITY[deriveSourceStatus(b).key]
      return dir === "desc" ? -cmp : cmp
    }
    case "upload_date": {
      const ta = a.listedAt ? Date.parse(a.listedAt) : NaN
      const tb = b.listedAt ? Date.parse(b.listedAt) : NaN
      return cmpNumNullsLastDir(
        Number.isFinite(ta) ? ta : null,
        Number.isFinite(tb) ? tb : null,
        dir
      )
    }
    case "total_sold":
      return cmpNumCoalesceZeroDir(a.totalSold, b.totalSold, dir)
    case "clicks_30d":
      return cmpNumCoalesceZeroDir(a.clicks30d, b.clicks30d, dir)
    default:
      return 0
  }
}

export const SOURCE_BADGE_COLORS: Record<SourceStatusKey, string> = {
  amazon_ok: "var(--accent)",
  unavailable: "var(--warn)",
  no_price: "var(--danger)",
  removed: "var(--dim)",
  price_increase: "var(--warn)",
  price_uncertain: "var(--warn)",
  check_failed: "var(--danger)",
  no_asin: "var(--info)",
  bot_zeroed: "var(--warn)",
}

// ─── Import validate ───────────────────────────────────────────

export type ImportRow = {
  row: number
  ebayId: string
  asin: string
}

export type ImportValidateStatus =
  | "Valid Format"
  | "Invalid ASIN"
  | "Missing eBay ID"
  | "Missing ASIN"
  | "Duplicate eBay ID"
  | "Duplicate ASIN"

export type ImportValidateResult = {
  row: number
  ebayId: string
  asin: string
  status: ImportValidateStatus
  message: string
}

export function parseImportText(raw: string): ImportRow[] {
  const lines = raw.split(/\r?\n/)
  const rows: ImportRow[] = []
  let rowNum = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    rowNum++
    const parts = trimmed.split(/[\t,;\s]+/).filter(Boolean)
    rows.push({
      row: rowNum,
      ebayId: (parts[0] ?? "").trim(),
      asin: (parts[1] ?? "").trim().toUpperCase(),
    })
  }
  return rows
}

export function validateImportRows(rows: ImportRow[]): ImportValidateResult[] {
  const ebayCounts = new Map<string, number>()
  const asinCounts = new Map<string, number>()
  for (const r of rows) {
    if (r.ebayId) ebayCounts.set(r.ebayId, (ebayCounts.get(r.ebayId) ?? 0) + 1)
    if (r.asin) asinCounts.set(r.asin, (asinCounts.get(r.asin) ?? 0) + 1)
  }

  return rows.map(r => {
    if (!r.ebayId) {
      return { ...r, status: "Missing eBay ID" as const, message: "eBay ID is required" }
    }
    if (!r.asin) {
      return { ...r, status: "Missing ASIN" as const, message: "ASIN is required" }
    }
    if (!ASIN_REGEX.test(r.asin)) {
      return { ...r, status: "Invalid ASIN" as const, message: "ASIN must be 10 alphanumeric characters" }
    }
    if ((ebayCounts.get(r.ebayId) ?? 0) > 1) {
      return { ...r, status: "Duplicate eBay ID" as const, message: "This eBay ID appears more than once" }
    }
    if ((asinCounts.get(r.asin) ?? 0) > 1) {
      return { ...r, status: "Duplicate ASIN" as const, message: "Duplicate ASIN — warning only" }
    }
    return { ...r, status: "Valid Format" as const, message: "Ready for import" }
  })
}

export function buildImportMatchErrorCsv(
  results: { row: number; ebayItemId: string; asin: string; status: string; message: string }[]
): string {
  const errors = results.filter(
    r =>
      r.status !== "UPDATED" &&
      r.status !== "ALREADY_EXISTS" &&
      r.status !== "DUPLICATE_ASIN_WARNING"
  )
  const header = "row,ebay_id,asin,status,message"
  const lines = errors.map(
    r =>
      `${r.row},"${r.ebayItemId.replace(/"/g, '""')}","${r.asin.replace(/"/g, '""')}","${r.status}","${r.message.replace(/"/g, '""')}"`
  )
  return [header, ...lines].join("\n")
}

export function buildErrorListCsv(results: ImportValidateResult[]): string {
  const errors = results.filter(r => r.status !== "Valid Format" && r.status !== "Duplicate ASIN")
  const header = "row,ebay_id,asin,status,message"
  const lines = errors.map(
    r =>
      `${r.row},"${r.ebayId.replace(/"/g, '""')}","${r.asin.replace(/"/g, '""')}","${r.status}","${r.message.replace(/"/g, '""')}"`
  )
  return [header, ...lines].join("\n")
}

const IMPORT_MATCH_SUCCESS_STATUSES = new Set([
  "UPDATED",
  "ALREADY_EXISTS",
  "DUPLICATE_ASIN_WARNING",
])

/** Escape CSV cell and neutralize formula injection (=, +, -, @). */
export function escapeCsvCell(value: string): string {
  let cell = value.replace(/"/g, '""')
  if (/^[=+\-@]/.test(cell)) {
    cell = `'${cell}`
  }
  return `"${cell}"`
}

export function buildUserImportMatchErrorCsv(
  results: { ebayItemId: string; asin: string; status: string; message: string }[]
): string {
  const errors = results.filter(r => !IMPORT_MATCH_SUCCESS_STATUSES.has(r.status))
  if (errors.length === 0) return ""
  const header = "ebayItemId,asin,status,message"
  const lines = errors.map(r =>
    [r.ebayItemId, r.asin, r.status, r.message].map(v => escapeCsvCell(v ?? "")).join(",")
  )
  return [header, ...lines].join("\n")
}

export function formatUserImportMatchErrorFilename(storeCode: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `listjetgo-asin-match-errors-${storeCode}-${stamp}.csv`
}

export function formatUserCsvTimestamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

export function formatUserSelectedListingsFilename(storeCode: string): string {
  return `listjetgo-selected-listings-${storeCode}-${formatUserCsvTimestamp()}.csv`
}

export function formatUserSelectedStockAlertsFilename(storeCode: string): string {
  return `listjetgo-selected-stock-alerts-${storeCode}-${formatUserCsvTimestamp()}.csv`
}

function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return escapeCsvCell("")
  if (typeof value === "boolean") return escapeCsvCell(value ? "true" : "false")
  return escapeCsvCell(String(value))
}

export type UserSelectedListingCsvRow = {
  catalogStateId:    number
  title:             string | null
  asin:              string | null
  ebayItemId:        string | null
  ebayPrice:         number | null
  sourcePrice:       number | null
  sourcePriceSource: string | null
  ebayQuantity:      number | null
  status:            string | null
  stockGuardEnabled: boolean
  updatedAt:         string | null
}

export function buildUserSelectedListingsCsv(rows: UserSelectedListingCsvRow[]): string {
  const header =
    "catalogStateId,title,asin,ebayItemId,ebayPrice,sourcePrice,sourcePriceSource,ebayQuantity,status,stockGuardEnabled,updatedAt"
  const lines = rows.map(r =>
    [
      r.catalogStateId,
      r.title,
      r.asin,
      r.ebayItemId,
      r.ebayPrice,
      r.sourcePrice,
      r.sourcePriceSource,
      r.ebayQuantity,
      r.status,
      r.stockGuardEnabled,
      r.updatedAt,
    ]
      .map(v => csvCell(v))
      .join(",")
  )
  return [header, ...lines].join("\n")
}

export type UserSelectedStockAlertCsvRow = {
  alertId:            number
  catalogStateId:     number
  listingTitle:       string | null
  asin:               string
  ebayItemId:         string | null
  sourceStatus:       string
  sourceStatusReason: string | null
  reviewStatus:       string
  ebayPrice:          number | null
  sourcePrice:        number | null
  oldSourcePrice:     number | null
  newSourcePrice:     number | null
  priceChangePercent: number | null
  ebayQuantity:       number | null
  actionError:        string | null
  createdAt:          string
  updatedAt:          string
}

export function buildUserSelectedStockAlertsCsv(rows: UserSelectedStockAlertCsvRow[]): string {
  const header =
    "alertId,catalogStateId,listingTitle,asin,ebayItemId,sourceStatus,sourceStatusReason,reviewStatus,ebayPrice,sourcePrice,oldSourcePrice,newSourcePrice,priceChangePercent,ebayQuantity,actionError,createdAt,updatedAt"
  const lines = rows.map(r =>
    [
      r.alertId,
      r.catalogStateId,
      r.listingTitle,
      r.asin,
      r.ebayItemId,
      r.sourceStatus,
      r.sourceStatusReason,
      r.reviewStatus,
      r.ebayPrice,
      r.sourcePrice,
      r.oldSourcePrice,
      r.newSourcePrice,
      r.priceChangePercent,
      r.ebayQuantity,
      r.actionError,
      r.createdAt,
      r.updatedAt,
    ]
      .map(v => csvCell(v))
      .join(",")
  )
  return [header, ...lines].join("\n")
}

export function downloadCsvFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Amazon product URL from validated ASIN only — never uses sourceUrl. */
export function safeAmazonUrlFromAsin(asin: string | null | undefined): string | null {
  const normalized = asin?.trim().toUpperCase() ?? ""
  if (!ASIN_REGEX.test(normalized)) return null
  return `https://www.amazon.com/dp/${encodeURIComponent(normalized)}`
}

export function normalizeDisplayAsin(asin: string | null | undefined): string | null {
  const normalized = asin?.trim().toUpperCase() ?? ""
  return normalized || null
}

/** eBay listing URL from numeric item ID only. */
export function safeEbayListingUrl(ebayItemId: string | null | undefined): string | null {
  const id = ebayItemId?.trim() ?? ""
  if (!/^\d+$/.test(id)) return null
  return `https://www.ebay.com/itm/${encodeURIComponent(id)}`
}

export function hasUserImportMatchErrors(
  results: { status: string }[] | undefined
): boolean {
  if (!results?.length) return false
  return results.some(r => !IMPORT_MATCH_SUCCESS_STATUSES.has(r.status))
}
