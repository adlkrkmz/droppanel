import type { MonitorItem } from "./monitorTypes"

export type StatusFilterKey =
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

export type SortByKey =
  | "title"
  | "asin"
  | "ebayItemId"
  | "quantity"
  | "ebayPrice"
  | "sourcePrice"
  | "sourceStatus"
  | "listedAt"
  | "totalSold"
  | "clicks30d"
  | "watchOrViews"

export type SortDir = "asc" | "desc"

const ASIN_REGEX = /^[A-Z0-9]{10}$/

type SourceStatusKey =
  | "amazon_ok"
  | "unavailable"
  | "no_price"
  | "removed"
  | "price_increase"
  | "check_failed"
  | "no_asin"
  | "bot_zeroed"

const DB_STATUS_LABELS: Record<string, SourceStatusKey> = {
  AMAZON_OK:    "amazon_ok",
  UNAVAILABLE:  "unavailable",
  NO_PRICE:     "no_price",
  REMOVED:      "removed",
  PRICE_INCREASE: "price_increase",
  CHECK_FAILED: "check_failed",
  NO_ASIN:      "no_asin",
  BOT_ZEROED:   "bot_zeroed",
}

const STATUS_PRIORITY: Record<SourceStatusKey, number> = {
  bot_zeroed: 0,
  unavailable: 1,
  no_price: 2,
  price_increase: 2,
  removed: 3,
  check_failed: 4,
  no_asin: 5,
  amazon_ok: 6,
}

function hasValidPrice(item: MonitorItem): boolean {
  return typeof item.ebayPrice === "number" && Number.isFinite(item.ebayPrice) && item.ebayPrice > 0
}

function isCheckFailed(item: MonitorItem): boolean {
  if (!Number.isFinite(item.quantity)) return true
  if (!hasValidPrice(item)) return false
  if (item.isTracked && !item.ebayItemId?.trim()) return true
  return false
}

function deriveSourceStatusKey(item: MonitorItem): SourceStatusKey {
  const fromDb = item.sourceStatus?.trim().toUpperCase()
  if (fromDb && DB_STATUS_LABELS[fromDb]) return DB_STATUS_LABELS[fromDb]

  const status = (item.currentStatus ?? "").toLowerCase()
  if (status === "ended") return "removed"
  if (!item.asin?.trim()) return "no_asin"
  if (!hasValidPrice(item)) return "no_price"
  if (item.quantity === 0 && item.botZeroedAt) return "bot_zeroed"
  if (isCheckFailed(item)) return "check_failed"
  if (item.asin && !item.sourceUrl?.trim()) return "unavailable"
  return "amazon_ok"
}

export function passesStatusFilter(item: MonitorItem, filter: StatusFilterKey): boolean {
  const srcKey = deriveSourceStatusKey(item)
  switch (filter) {
    case "all":
      return true
    case "active":
      return item.quantity > 0 && !item.panelHiddenAt
    case "qty0":
      return item.quantity === 0
    case "bot_zeroed":
      return srcKey === "bot_zeroed" || Boolean(item.botZeroedAt)
    case "amazon_unavailable":
      return srcKey === "unavailable"
    case "no_price":
      return srcKey === "no_price"
    case "check_failed":
      return srcKey === "check_failed"
    case "no_asin":
      return srcKey === "no_asin"
    case "guard_on":
      return item.stockGuardEnabled !== false
    case "guard_off":
      return item.stockGuardEnabled === false
    default:
      return true
  }
}

export function applySearchFilter(items: MonitorItem[], search: string): MonitorItem[] {
  const q = search.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    item =>
      (item.title ?? "").toLowerCase().includes(q) ||
      (item.asin ?? "").toLowerCase().includes(q) ||
      (item.ebayItemId ?? "").toLowerCase().includes(q)
  )
}

function watchOrViewsSortKey(item: MonitorItem): number | null {
  const watch = toSortNumber(item.watchCount)
  if (watch != null) return watch
  return toSortNumber(item.views30d)
}

export function toSortNumber(value: unknown): number | null {
  if (value == null || value === "") return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  const s = String(value).trim()
  if (!s || s === "—" || s === "-") return null
  const n = Number(s.replace(/[^0-9.-]/g, ""))
  return Number.isFinite(n) ? n : null
}

/** Sold / 30D Clicks: missing counts as 0 for display and sort. */
export function coalesceSoldOrClicks(value: unknown): number {
  const n = toSortNumber(value)
  return n == null ? 0 : n
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

/** Null/missing always last; direction applies only to numeric values (0 is valid). */
function cmpNumNullsLastDir(
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

function defaultStatusSort(a: MonitorItem, b: MonitorItem): number {
  const pa = STATUS_PRIORITY[deriveSourceStatusKey(a)]
  const pb = STATUS_PRIORITY[deriveSourceStatusKey(b)]
  if (pa !== pb) return pa - pb
  if (a.quantity === 0 && b.quantity !== 0) return -1
  if (b.quantity === 0 && a.quantity !== 0) return 1
  return a.sku.localeCompare(b.sku)
}

export function sortMonitorItems(
  items: MonitorItem[],
  sortBy: SortByKey | undefined,
  sortDir: SortDir
): MonitorItem[] {
  const sorted = [...items]
  if (!sortBy) {
    sorted.sort(defaultStatusSort)
    return sorted
  }

  sorted.sort((a, b) => {
    switch (sortBy) {
      case "title":
        return cmpStrNullsLastDir(a.title, b.title, sortDir)
      case "asin":
        return cmpStrNullsLastDir(a.asin, b.asin, sortDir)
      case "ebayItemId":
        return cmpStrNullsLastDir(a.ebayItemId, b.ebayItemId, sortDir)
      case "quantity":
        return cmpNumNullsLastDir(a.quantity, b.quantity, sortDir)
      case "ebayPrice":
        return cmpNumNullsLastDir(
          hasValidPrice(a) ? a.ebayPrice : null,
          hasValidPrice(b) ? b.ebayPrice : null,
          sortDir
        )
      case "sourcePrice":
        return cmpNumNullsLastDir(a.sourcePrice, b.sourcePrice, sortDir)
      case "sourceStatus": {
        const cmp =
          STATUS_PRIORITY[deriveSourceStatusKey(a)] -
          STATUS_PRIORITY[deriveSourceStatusKey(b)]
        return sortDir === "desc" ? -cmp : cmp
      }
      case "listedAt": {
        const ta = a.listedAt ? Date.parse(a.listedAt) : NaN
        const tb = b.listedAt ? Date.parse(b.listedAt) : NaN
        return cmpNumNullsLastDir(
          Number.isFinite(ta) ? ta : null,
          Number.isFinite(tb) ? tb : null,
          sortDir
        )
      }
      case "totalSold":
        return cmpNumCoalesceZeroDir(a.totalSold, b.totalSold, sortDir)
      case "clicks30d":
        return cmpNumCoalesceZeroDir(a.clicks30d, b.clicks30d, sortDir)
      case "watchOrViews":
        return cmpNumNullsLastDir(watchOrViewsSortKey(a), watchOrViewsSortKey(b), sortDir)
      default:
        return 0
    }
  })
  return sorted
}

const VALID_SORT_BY = new Set<string>([
  "title",
  "asin",
  "ebayItemId",
  "quantity",
  "ebayPrice",
  "sourcePrice",
  "sourceStatus",
  "listedAt",
  "totalSold",
  "clicks30d",
  "watchOrViews",
])

const SORT_BY_ALIASES: Record<string, SortByKey> = {
  title: "title",
  asin: "asin",
  ebayitemid: "ebayItemId",
  ebay_item_id: "ebayItemId",
  quantity: "quantity",
  ebayprice: "ebayPrice",
  ebay_price: "ebayPrice",
  price: "ebayPrice",
  sourceprice: "sourcePrice",
  source_price: "sourcePrice",
  amazon_price: "sourcePrice",
  sourcestatus: "sourceStatus",
  source_status: "sourceStatus",
  listedat: "listedAt",
  listed_at: "listedAt",
  upload_date: "listedAt",
  totalsold: "totalSold",
  total_sold: "totalSold",
  clicks30d: "clicks30d",
  clicks_30d: "clicks30d",
  watchorviews: "watchOrViews",
  watch_or_views: "watchOrViews",
  views_30d: "watchOrViews",
}

export function parseSortBy(raw: string | undefined): SortByKey | undefined {
  const v = raw?.trim()
  if (!v) return undefined
  if (VALID_SORT_BY.has(v)) return v as SortByKey
  const alias = SORT_BY_ALIASES[v.toLowerCase()]
  return alias
}

export function parseSortDir(raw: string | undefined): SortDir {
  return raw?.trim().toLowerCase() === "desc" ? "desc" : "asc"
}

export function parseStatusFilter(raw: string | undefined): StatusFilterKey {
  const v = raw?.trim() as StatusFilterKey
  const allowed: StatusFilterKey[] = [
    "all", "active", "qty0", "bot_zeroed", "amazon_unavailable",
    "no_price", "check_failed", "no_asin", "guard_on", "guard_off",
  ]
  return allowed.includes(v) ? v : "all"
}
