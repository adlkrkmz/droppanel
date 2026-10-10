"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { fetchAuthMe, type UserPublic } from "@/lib/userAuthClient"
import {
  fetchAppImportStatus,
  fetchAppListings,
  fetchAppRecommendedPrice,
  fetchAppStores,
  updateAppListingPrice,
  updateAppListingStockGuard,
  bulkUpdateAppListingStockGuard,
  bulkHideAppListings,
  bulkEndAppListings,
  setAppListingQuantity,
  bulkSetAppListingQuantity,
  applyAppListingPromotion,
  verifyAppListingPromotion,
  retryAppListingPromotion,
  bulkApplyAppListingPromotion,
  updateAppListingSourceAsin,
  endAppListing,
  syncAppListings,
  type AppImportStatusResponse,
  type AppListingItem,
  type AppBulkListingStockGuardResponse,
  type AppBulkHideListingsResponse,
  type AppBulkEndListingsResponse,
  type AppListingsFilter,
  type AppListingsSort,
  type AppRecommendedPriceResponse,
  type AppStoreSummary,
  type AppUpdateListingPriceResponse,
} from "@/lib/userAppClient"
import {
  normalizeDisplayAsin,
  safeAmazonUrlFromAsin,
  safeEbayListingUrl,
  buildUserSelectedListingsCsv,
  downloadCsvFile,
  formatUserSelectedListingsFilename,
  formatSoldCount,
} from "@/lib/listingsUtils"
import {
  BULK_LISTINGS_MAX,
  bulkOverLimitTitle,
  formatBulkBatchRef,
  getBulkResultOutcomeMessage,
} from "@/lib/bulkActionsUi"
import { NoStoreEmptyState } from "@/components/app/NoStoreEmptyState"
import { useFocusRefetch } from "@/components/app/useFocusRefetch"
import "@/components/listings/listings-page.css"
import {
  adoptStoreSelection,
  parseUrlStoreId,
  storeCodeForId,
  useAppStoreSelection,
} from "@/lib/appStoreSelection"

const PAGE_SIZE_OPTIONS = [25, 50, 100]

const FILTER_OPTIONS: { value: AppListingsFilter; label: string }[] = [
  { value: "all",             label: "All listings" },
  { value: "needs-asin",      label: "Needs ASIN" },
  { value: "asin-linked",     label: "ASIN linked" },
  { value: "source-tracked",  label: "Source tracked" },
  { value: "source-missing",  label: "Source missing" },
  { value: "qty0",            label: "Qty 0" },
  { value: "bot_zeroed",      label: "Bot zeroed" },
  { value: "unavailable",     label: "Source unavailable" },
  { value: "no_price",        label: "No source price" },
  { value: "check_failed",    label: "Check failed" },
  { value: "guard-on",        label: "Guard On" },
  { value: "guard-off",       label: "Guard Off" },
]

function dash(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—"
  return String(v)
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `$${n.toFixed(2)}`
}

function fmtDate(s: string | null | undefined): string {
  if (!s?.trim()) return "—"
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString()
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

function fmtDateParts(s: string | null | undefined): { date: string; time: string } | null {
  if (!s?.trim()) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return {
    date: `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
  }
}

function fmtStamp(s: string | null | undefined): string | null {
  const parts = fmtDateParts(s)
  if (!parts) return null
  return `${parts.date} ${parts.time}`
}

function fmtCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US")
}

function sourceBadgeVariant(item: AppListingItem): "ok" | "warn" | "dim" | "info" | "critical" {
  const s = item.sourceStatus?.trim().toUpperCase() ?? ""
  if (s === "AMAZON_OK") return "ok"
  if (s === "UNAVAILABLE") return "critical"
  if (s === "NO_ASIN") return "warn"
  if (s === "NO_PRICE" || s === "CHECK_FAILED" || s === "BOT_ZEROED" || s === "REMOVED" || s === "PRICE_INCREASE" || s === "PRICE_UNCERTAIN") {
    return "warn"
  }
  if (hasSourceTracked(item)) return "info"
  return "dim"
}

function hasAsin(item: AppListingItem): boolean {
  return Boolean(item.asin?.trim())
}

function hasSourceTracked(item: AppListingItem): boolean {
  return (
    (item.sourcePrice != null && Number.isFinite(item.sourcePrice)) ||
    Boolean(item.sourcePriceSource?.trim())
  )
}

function syncListingsUrl(code: string, activeFilter: AppListingsFilter, pageNum: number) {
  const url = new URL(window.location.href)
  url.searchParams.set("storeCode", code)
  if (activeFilter === "all") url.searchParams.delete("filter")
  else url.searchParams.set("filter", activeFilter)
  if (pageNum <= 1) url.searchParams.delete("page")
  else url.searchParams.set("page", String(pageNum))
  window.history.replaceState(null, "", url.pathname + url.search)
}

function getFilterEmptyState(
  filter: AppListingsFilter,
  store: AppStoreSummary | undefined,
  importAsinHref: string,
  importListingsHref: string
): {
  title: string
  description: string
  primaryHref?: string
  primaryLabel?: string
} {
  if (filter === "all") {
    return {
      title: "No listings imported yet.",
      description: "Import your active eBay listings first. Existing listings will be updated, not duplicated.",
      primaryHref: importListingsHref,
      primaryLabel: "Import Listings",
    }
  }

  if (filter === "needs-asin") {
    const storeNeeds = store?.needsAsinCount
    const storeListings = store?.listingCount ?? 0

    if (store != null && storeListings > 0 && storeNeeds === 0) {
      return {
        title: "All imported listings have ASINs linked.",
        description: "This store has no listings waiting for ASIN linking.",
      }
    }

    if (store != null && storeNeeds != null && storeNeeds > 0) {
      return {
        title: "No ASIN-missing listings found for this filter.",
        description: `Store summary still shows ${storeNeeds} listing${storeNeeds === 1 ? "" : "s"} needing ASINs. Use the ASIN linking tool to connect source products.`,
        primaryHref: importAsinHref,
        primaryLabel: "Link Amazon ASINs",
      }
    }

    return {
      title: "No ASIN-missing listings found.",
      description: "This store has no listings matching the Needs ASIN filter.",
      primaryHref: importAsinHref,
      primaryLabel: "Link Amazon ASINs",
    }
  }

  if (filter === "source-missing") {
    return {
      title: "No source-missing listings found.",
      description: "All visible listings in this store have source price or source tracking data.",
    }
  }

  if (filter === "asin-linked") {
    return {
      title: "No ASIN-linked listings found.",
      description: "No listings in this store match the ASIN linked filter.",
      primaryHref: importAsinHref,
      primaryLabel: "Link Amazon ASINs",
    }
  }

  if (filter === "guard-on") {
    return {
      title: "No listings with Stock Guard enabled.",
      description:
        "Enable Stock Guard on listings you want to monitor for source price and availability risk.",
      primaryHref: `/app/listings?storeCode=${encodeURIComponent(store?.storeCode ?? "")}`,
      primaryLabel: "View All Listings",
    }
  }

  if (filter === "guard-off") {
    return {
      title: "All listings on this store have Stock Guard enabled.",
      description: "You can disable Stock Guard per listing if needed.",
    }
  }

  return {
    title: "No source-tracked listings found.",
    description: "No listings in this store match the source tracked filter.",
  }
}

function priceComparisonMessage(recommended: number, current: number): string {
  const r = Math.round(recommended * 100)
  const c = Math.round(current * 100)
  if (r > c) return "Recommended price is higher than your current eBay price."
  if (r < c) return "No price increase is needed. Price decrease is not applied from the user panel."
  return "Current eBay price already matches the recommendation."
}

function parseEditableUsdPrice(raw: string): number | null {
  const normalized = raw.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) return null
  const value = Number(normalized)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value * 100) / 100
}

function applySafetyMessage(data: AppRecommendedPriceResponse | null): string | null {
  if (!data) return null
  if (data.pricingSource === "unavailable" || data.recommendedEbayPrice <= 0 || data.amazonPrice <= 0) {
    return "Price update is not available for this listing."
  }
  return priceComparisonMessage(data.recommendedEbayPrice, data.currentEbayPrice)
}

function mapPriceUpdateError(error: string, status: number): { text: string; info: boolean } {
  if (/no price increase needed/i.test(error)) {
    return { text: error, info: true }
  }
  if (status >= 500 || /price update failed/i.test(error)) {
    return { text: "Price update failed.", info: false }
  }
  if (error.length <= 120 && !/stack|trace|oauth|token/i.test(error)) {
    return { text: error, info: false }
  }
  return { text: "Price update failed.", info: false }
}

function formatPricingSource(source: string): string {
  return source.replace(/_/g, " ")
}

function stockAlertsHref(code: string): string {
  const q = new URLSearchParams({
    storeCode: code,
    status: "all",
    page: "1",
  })
  return `/app/stock-alerts?${q.toString()}`
}

function formatSyncStatusLabel(status: string | null): string {
  if (!status) return "Not started"
  const s = status.toLowerCase()
  if (s === "ok") return "Completed"
  if (s === "error") return "Failed"
  if (["pending", "catalog_running", "metrics_running", "running"].includes(s)) return "Running"
  if (s === "idle") return "Waiting"
  return status
}

function truncateSyncError(msg: string): string {
  const trimmed = msg.trim()
  if (trimmed.length <= 120) return trimmed
  return `${trimmed.slice(0, 117)}…`
}

function ListingSyncStatusCard({
  status,
  loading,
  error,
  importListingsHref,
}: {
  status: AppImportStatusResponse | null
  loading: boolean
  error: string | null
  importListingsHref: string
}) {
  const statusLabel = formatSyncStatusLabel(status?.syncStatus ?? null)
  const isFailed = status?.syncStatus?.toLowerCase() === "error"

  return (
    <div
      style={{
        marginBottom: 16,
        padding: 14,
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--surface)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>Listing Sync Status</div>
        <Link href={importListingsHref} style={summaryCtaStyle}>
          Import Listings
        </Link>
      </div>

      {error && (
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "#e88" }}>{error}</p>
      )}

      <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
        <div style={syncStatusRowStyle}>
          <span style={{ color: "var(--dim)" }}>Status</span>
          <span style={{ color: isFailed ? "#e88" : "inherit" }}>
            {loading && !status ? "Loading…" : statusLabel}
          </span>
        </div>
        <div style={syncStatusRowStyle}>
          <span style={{ color: "var(--dim)" }}>Last sync</span>
          <span>{fmtDate(status?.lastCatalogSyncAt)}</span>
        </div>
        <div style={syncStatusRowStyle}>
          <span style={{ color: "var(--dim)" }}>Listings</span>
          <span>{status != null ? String(status.listingCount) : "—"}</span>
        </div>
        <div style={syncStatusRowStyle}>
          <span style={{ color: "var(--dim)" }}>Active listings</span>
          <span>{status != null ? String(status.activeListingCount) : "—"}</span>
        </div>
        <div style={syncStatusRowStyle}>
          <span style={{ color: "var(--dim)" }}>Pending alerts</span>
          <span>{status != null ? String(status.pendingAlerts) : "—"}</span>
        </div>
      </div>

      {status?.syncError && (
        <p style={{ margin: "12px 0 0", fontSize: 12, color: "#ca6", lineHeight: 1.5 }}>
          <strong style={{ color: "inherit" }}>Error:</strong> {truncateSyncError(status.syncError)}
        </p>
      )}
    </div>
  )
}

function StoreAsinSummaryCard({
  store,
  importAsinHref,
  importListingsHref,
  pageLinkedFallback,
  pageNeedsFallback,
}: {
  store: AppStoreSummary
  importAsinHref: string
  importListingsHref: string
  pageLinkedFallback?: number
  pageNeedsFallback?: number
}) {
  const linked =
    typeof store.asinLinkedCount === "number" ? store.asinLinkedCount : (pageLinkedFallback ?? "—")
  const needs =
    typeof store.needsAsinCount === "number" ? store.needsAsinCount : (pageNeedsFallback ?? "—")
  const completion =
    typeof store.asinCompletionPercent === "number" ? `${store.asinCompletionPercent}%` : "—"

  return (
    <div
      style={{
        marginBottom: 16,
        padding: 14,
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--surface)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>ASIN Linking</div>
          <div style={{ fontSize: 13, color: "var(--dim)", lineHeight: 1.6 }}>
            Linked: {linked} · Needs ASIN: {needs} · Completion: {completion}
          </div>
          <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 4 }}>
            {store.storeCode} · {store.name}
          </div>
        </div>
        <div>
          {store.listingCount === 0 ? (
            <Link href={importListingsHref} style={summaryCtaStyle}>
              Import Listings
            </Link>
          ) : store.needsAsinCount > 0 ? (
            <Link href={importAsinHref} style={summaryCtaStyle}>
              Link Amazon ASINs
            </Link>
          ) : (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "6px 12px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                background: "rgba(60,180,120,0.15)",
                color: "#6c9",
              }}
            >
              All ASINs linked
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function ListingsStoreSelect({
  stores,
  value,
  onChange,
}: {
  stores: AppStoreSummary[]
  value: string
  onChange: (storeId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = stores.find(s => String(s.storeId) === value)

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div className={`lj-store${open ? " lj-store--open" : ""}`} ref={rootRef}>
      <span className="lj-store-dot" aria-hidden="true" />
      <button
        type="button"
        className="lj-store-trigger"
        aria-label="Store"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span className="lj-store-label">
          {selected ? `${selected.storeCode} — ${selected.name}` : "Store"}
        </span>
        <span className="lj-store-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="lj-store-menu" role="listbox" aria-label="Store">
          {stores.map(store => {
            const id = String(store.storeId)
            const active = id === value
            return (
              <li key={store.storeId} role="option" aria-selected={active}>
                <button
                  type="button"
                  className={`lj-store-option${active ? " lj-store-option--selected" : ""}`}
                  onClick={() => {
                    onChange(id)
                    setOpen(false)
                  }}
                >
                  {store.storeCode} — {store.name}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default function AppListingsPage() {
  const router = useRouter()
  const { selectedStoreId, setSelectedStoreId, isStoreSelectionReady } = useAppStoreSelection()
  const selectedStoreIdRef = useRef(selectedStoreId)
  selectedStoreIdRef.current = selectedStoreId
  const storeCodeRef = useRef("")
  const [user, setUser] = useState<UserPublic | null>(null)
  const [stores, setStores] = useState<AppStoreSummary[]>([])
  const [storeCode, setStoreCode] = useState<string>("")
  storeCodeRef.current = storeCode
  const [items, setItems] = useState<AppListingItem[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [filter, setFilter] = useState<AppListingsFilter>("all")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [pageSize, setPageSize] = useState(50)
  const [sort, setSort] = useState<AppListingsSort | null>("updated")
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc")
  const [loading, setLoading] = useState(true)
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
  const [listLoading, setListLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [priceModalItem, setPriceModalItem] = useState<AppListingItem | null>(null)
  const [guardModalItem, setGuardModalItem] = useState<{
    item: AppListingItem
    enabled: boolean
  } | null>(null)
  const [bulkGuardModal, setBulkGuardModal] = useState<{ enabled: boolean } | null>(null)
  const [bulkHideModalOpen, setBulkHideModalOpen] = useState(false)
  const [bulkEndModalOpen, setBulkEndModalOpen] = useState(false)
  const [asinModalItem, setAsinModalItem] = useState<AppListingItem | null>(null)
  const [endModalItem, setEndModalItem] = useState<AppListingItem | null>(null)
  const [promoModalItem, setPromoModalItem] = useState<AppListingItem | null>(null)
  const [bulkPromoOpen, setBulkPromoOpen] = useState(false)
  const [selectedByCatalogId, setSelectedByCatalogId] = useState<Map<number, AppListingItem>>(
    () => new Map()
  )
  const selectAllListingsRef = useRef<HTMLInputElement>(null)
  const [qtyBusyId, setQtyBusyId] = useState<number | null>(null)
  const [pendingQtyIds, setPendingQtyIds] = useState<Set<number>>(() => new Set())
  const [bulkQtyBusy, setBulkQtyBusy] = useState(false)
  const [bulkQtyBusyQuantity, setBulkQtyBusyQuantity] = useState<0 | 1 | null>(null)
  const [bulkQtyBusyStoreId, setBulkQtyBusyStoreId] = useState<number | null>(null)
  const [actionNotice, setActionNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [priceLoading, setPriceLoading] = useState(false)
  const [priceError, setPriceError] = useState<string | null>(null)
  const [priceData, setPriceData] = useState<AppRecommendedPriceResponse | null>(null)
  const [importStatus, setImportStatus] = useState<AppImportStatusResponse | null>(null)
  const [importStatusLoading, setImportStatusLoading] = useState(false)
  const [importStatusError, setImportStatusError] = useState<string | null>(null)
  const [catalogSyncBusy, setCatalogSyncBusy] = useState(false)
  const listingsRequestSeq = useRef(0)
  const listingsAbortRef = useRef<AbortController | null>(null)
  const bulkQtyOperationSeq = useRef(0)
  const activeBulkQtyOperation = useRef<number | null>(null)
  const storeContextVersion = useRef(0)
  const previousStoreContext = useRef({ storeId: selectedStoreId, storeCode })

  useEffect(() => () => listingsAbortRef.current?.abort(), [])

  useEffect(() => {
    if (
      previousStoreContext.current.storeId !== selectedStoreId ||
      previousStoreContext.current.storeCode !== storeCode
    ) {
      previousStoreContext.current = { storeId: selectedStoreId, storeCode }
      storeContextVersion.current += 1
      setQtyBusyId(null)
      setPendingQtyIds(new Set())
    }
  }, [selectedStoreId, storeCode])

  useEffect(() => {
    const closeMenus = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      document.querySelectorAll<HTMLDetailsElement>(".app-listing-actions details[open]").forEach(details => {
        if (!target.closest(".app-listing-actions") || !details.contains(target)) details.open = false
      })
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") document.querySelectorAll<HTMLDetailsElement>(".app-listing-actions details[open]").forEach(details => { details.open = false })
    }
    document.addEventListener("click", closeMenus)
    document.addEventListener("keydown", closeOnEscape)
    return () => { document.removeEventListener("click", closeMenus); document.removeEventListener("keydown", closeOnEscape) }
  }, [])

  const selectedStore = useMemo(
    () => stores.find(s => s.storeId === selectedStoreId) ?? stores.find(s => s.storeCode === storeCode),
    [stores, selectedStoreId, storeCode]
  )

  const importAsinHref = useMemo(
    () => `/app/import?storeCode=${encodeURIComponent(storeCode)}&mode=asin-match`,
    [storeCode]
  )

  const importListingsHref = useMemo(
    () => `/app/import?storeCode=${encodeURIComponent(storeCode)}`,
    [storeCode]
  )

  const pageAsinLinked = useMemo(() => items.filter(hasAsin).length, [items])
  const pageNeedsAsin = useMemo(() => items.filter(item => !hasAsin(item)).length, [items])
  const pageSourceTracked = useMemo(() => items.filter(hasSourceTracked).length, [items])
  const pageSourceMissing = useMemo(() => items.filter(item => !hasSourceTracked(item)).length, [items])

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize])

  const selectableListings = useMemo(
    () => items.filter(item => item.catalogStateId > 0),
    [items]
  )

  const selectedListingsCount = selectedByCatalogId.size

  const currentPageSelectedCount = useMemo(
    () => selectableListings.filter(item => selectedByCatalogId.has(item.catalogStateId)).length,
    [selectableListings, selectedByCatalogId]
  )

  const selectedListingItems = useMemo(
    () => [...selectedByCatalogId.values()],
    [selectedByCatalogId]
  )

  const bulkGuardEligibleCount = useMemo(
    () => selectedListingItems.filter(canToggleStockGuard).length,
    [selectedListingItems]
  )

  const bulkGuardIneligibleCount = useMemo(
    () => selectedListingItems.filter(item => !canToggleStockGuard(item)).length,
    [selectedListingItems]
  )

  const canOpenBulkGuard =
    Boolean(storeCode) &&
    selectedListingsCount > 0 &&
    bulkGuardEligibleCount > 0 &&
    bulkGuardEligibleCount <= BULK_LISTINGS_MAX

  const bulkHideEligibleCount = useMemo(
    () => selectedListingItems.filter(item => item.catalogStateId > 0).length,
    [selectedListingItems]
  )

  const canOpenBulkHide =
    Boolean(storeCode) &&
    selectedListingsCount > 0 &&
    bulkHideEligibleCount > 0 &&
    bulkHideEligibleCount <= BULK_LISTINGS_MAX

  const bulkEndEligibleCount = useMemo(
    () => selectedListingItems.filter(canEndListing).length,
    [selectedListingItems]
  )

  const bulkEndIneligibleCount = useMemo(
    () => selectedListingItems.filter(item => !canEndListing(item)).length,
    [selectedListingItems]
  )

  const canOpenBulkEnd =
    Boolean(storeCode) &&
    selectedListingsCount > 0 &&
    bulkEndEligibleCount > 0

  const bulkSetQtyEligibleCount = useMemo(
    () => selectedListingItems.filter(canSetQuantity).length,
    [selectedListingItems]
  )

  const canOpenBulkSetQty =
    Boolean(storeCode) &&
    selectedListingsCount > 0 &&
    bulkSetQtyEligibleCount > 0 &&
    bulkSetQtyEligibleCount <= BULK_LISTINGS_MAX &&
    !bulkQtyBusy

  const bulkQtyWorkingFor = (quantity: 0 | 1) =>
    bulkQtyBusy &&
    bulkQtyBusyQuantity === quantity &&
    bulkQtyBusyStoreId === selectedStoreId

  const allSelectableListingsSelected = useMemo(
    () =>
      selectableListings.length > 0 &&
      selectableListings.every(item => selectedByCatalogId.has(item.catalogStateId)),
    [selectableListings, selectedByCatalogId]
  )

  const someSelectableListingsSelected = useMemo(
    () =>
      selectableListings.some(item => selectedByCatalogId.has(item.catalogStateId)) &&
      !allSelectableListingsSelected,
    [selectableListings, selectedByCatalogId, allSelectableListingsSelected]
  )

  useEffect(() => {
    setSelectedByCatalogId(new Map())
    setActionNotice(null)
  }, [storeCode, filter])

  useEffect(() => {
    const el = selectAllListingsRef.current
    if (el) el.indeterminate = someSelectableListingsSelected
  }, [someSelectableListingsSelected, allSelectableListingsSelected])

  const filterEmpty = useMemo(
    () => getFilterEmptyState(filter, selectedStore, importAsinHref, importListingsHref),
    [filter, selectedStore, importAsinHref, importListingsHref]
  )

  const loadListings = useCallback(
    async (code: string, pageNum: number, activeFilter: AppListingsFilter, activeSort = sort, activeDirection = sortDirection, activeQ = search, activeLimit = pageSize): Promise<boolean> => {
      if (!code) return false
      const requestId = ++listingsRequestSeq.current
      listingsAbortRef.current?.abort()
      const controller = new AbortController()
      listingsAbortRef.current = controller
      setListLoading(true)
      setError(null)
      try {
        const result = await fetchAppListings({
          storeCode: code,
          storeId: selectedStoreIdRef.current ?? undefined,
          page: pageNum,
          limit: activeLimit,
          filter: activeFilter,
          sort: activeSort,
          direction: activeDirection,
          q: activeQ,
          signal: controller.signal,
        })
        if (requestId !== listingsRequestSeq.current) return false
        if (!result.ok) {
          if (result.status === 401) {
            router.replace("/app/login")
            return false
          }
          if (result.status === 403 && result.approvalStatus === "pending_approval") {
            router.replace("/pending-approval")
            return false
          }
          setError(result.error)
          return false
        }
        setItems(result.data.items)
        setHasLoadedOnce(true)
        setTotal(result.data.total)
        setPage(result.data.page)
        if (result.data.marketingAccess && result.data.storeId) {
          const access = result.data.marketingAccess
          const sid = result.data.storeId
          setStores(prev =>
            prev.map(s =>
              s.storeId === sid
                ? { ...s, marketingAccess: access, hasMarketingScope: access.granted }
                : s
            )
          )
        }
        return true
      } catch (e) {
        if (controller.signal.aborted || requestId !== listingsRequestSeq.current) return false
        setError("Could not load listings.")
        return false
      } finally {
        if (requestId === listingsRequestSeq.current) {
          setListLoading(false)
          if (listingsAbortRef.current === controller) listingsAbortRef.current = null
        }
      }
    },
    [router]
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(1)
    }, 400)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    if (!storeCode || loading) return
    void loadListings(storeCode, page, filter, sort, sortDirection, debouncedSearch, pageSize)
  }, [storeCode, page, filter, sort, sortDirection, debouncedSearch, pageSize, loading, loadListings])

  function toggleSort(next: AppListingsSort) {
    const direction = sort === next ? (sortDirection === "desc" ? "asc" : "desc") : (next === "updated" ? "desc" : "asc")
    setSort(next)
    setSortDirection(direction)
    setPage(1)
  }

  function sortHeader(label: string, key: AppListingsSort) {
    return (
      <button type="button" onClick={() => toggleSort(key)} className="lj-sort">
        {label}
        {sort === key ? (sortDirection === "asc" ? " ↑" : " ↓") : ""}
      </button>
    )
  }

  const loadImportStatus = useCallback(async (storeId: number) => {
    if (!Number.isInteger(storeId) || storeId < 1) return
    setImportStatusLoading(true)
    setImportStatusError(null)
    const result = await fetchAppImportStatus({ storeId })
    setImportStatusLoading(false)
    if (!result.ok) {
      setImportStatusError("Could not load sync status.")
      return
    }
    setImportStatus(result.data)
  }, [])

  const init = useCallback(async () => {
    setLoading(true)
    setError(null)

    const u = await fetchAuthMe()
    if (!u) {
      router.replace("/app/login")
      return
    }
    if (u.approvalStatus !== "active") {
      router.replace(u.approvalStatus === "pending_approval" ? "/pending-approval" : "/app/login")
      return
    }
    setUser(u)

    const storesResult = await fetchAppStores()
    if (!storesResult.ok) {
      if (storesResult.status === 401) {
        router.replace("/app/login")
        return
      }
      if (storesResult.status === 403 && storesResult.approvalStatus === "pending_approval") {
        router.replace("/pending-approval")
        return
      }
      setError(storesResult.error)
      setLoading(false)
      return
    }

    const list = storesResult.data.stores
    setStores(list)

    if (list.length === 0) {
      setLoading(false)
      return
    }

    const params = new URLSearchParams(window.location.search)
    const urlCode = params.get("storeCode")?.trim() ?? ""
    const urlFilter = params.get("filter")?.trim() as AppListingsFilter | null
    const urlPage = Math.max(1, parseInt(params.get("page") ?? "1", 10) || 1)
    let initialFilter: AppListingsFilter = "all"
    if (urlFilter && FILTER_OPTIONS.some(o => o.value === urlFilter)) {
      initialFilter = urlFilter
      setFilter(urlFilter)
    }

    const adopted = adoptStoreSelection(list, {
      providerStoreId: selectedStoreIdRef.current,
      urlStoreId: parseUrlStoreId(params.get("storeId")),
      urlStoreCode: urlCode || null,
    })
    if (adopted.shouldWriteProvider && adopted.storeId != null) {
      setSelectedStoreId(adopted.storeId)
    }
    const validCode = storeCodeForId(list, adopted.storeId)
    setStoreCode(validCode)
    setLoading(false)
    setPage(urlPage)
    syncListingsUrl(validCode, initialFilter, urlPage)
    if (adopted.storeId != null) {
      await loadImportStatus(adopted.storeId)
    }
  }, [router, loadListings, loadImportStatus, setSelectedStoreId])

  useEffect(() => {
    if (!isStoreSelectionReady) return
    void init()
  }, [isStoreSelectionReady, init])

  // Keep page storeCode mirrored to provider when selection changes elsewhere.
  useEffect(() => {
    if (!isStoreSelectionReady || loading || stores.length === 0) return
    if (selectedStoreId == null) return
    const code = storeCodeForId(stores, selectedStoreId)
    if (!code || code === storeCode) return
    setStoreCode(code)
    setPage(1)
    void loadImportStatus(selectedStoreId)
    syncListingsUrl(code, filter, 1)
  }, [selectedStoreId, stores, isStoreSelectionReady, loading, storeCode, filter, loadImportStatus])

  const refreshStoreSummaries = useCallback(async () => {
    const storesResult = await fetchAppStores()
    if (storesResult.ok) {
      setStores(storesResult.data.stores)
    }
    if (selectedStoreId != null) {
      await loadImportStatus(selectedStoreId)
    }
  }, [selectedStoreId, loadImportStatus])

  const handleCatalogSync = useCallback(async () => {
    if (selectedStoreId == null || catalogSyncBusy) return
    setCatalogSyncBusy(true)
    setActionNotice(null)
    const result = await syncAppListings(selectedStoreId)
    if (!result.ok) {
      setCatalogSyncBusy(false)
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      setActionNotice({ kind: "error", text: result.error || "eBay listing sync failed." })
      return
    }

    setActionNotice({
      kind: "ok",
      text: result.data.message || "Catalog sync started. Listings and Sold will refresh shortly.",
    })

    const running = new Set(["pending", "catalog_running", "running"])
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 4000))
      const statusResult = await fetchAppImportStatus({ storeId: selectedStoreId })
      if (!statusResult.ok) break
      setImportStatus(statusResult.data)
      const st = statusResult.data.syncStatus?.toLowerCase() ?? ""
      if (!running.has(st)) {
        if (st === "error") {
          setActionNotice({
            kind: "error",
            text: statusResult.data.syncError || "eBay listing sync failed.",
          })
        } else {
          const code = storeCodeForId(stores, selectedStoreId)
          if (code) {
            await loadListings(code, page, filter, sort, sortDirection, debouncedSearch, pageSize)
          }
          await refreshStoreSummaries()
          setActionNotice({
            kind: "ok",
            text: "Synced from eBay: listings and Sold refreshed.",
          })
        }
        break
      }
    }
    setCatalogSyncBusy(false)
  }, [
    selectedStoreId,
    catalogSyncBusy,
    router,
    loadListings,
    refreshStoreSummaries,
    stores,
    page,
    filter,
    sort,
    sortDirection,
    debouncedSearch,
    pageSize,
  ])

  const refreshAfterPriceUpdate = useCallback(async (): Promise<boolean> => {
    if (!storeCode) return false
    const loaded = await loadListings(storeCode, page, filter, sort, sortDirection, search, pageSize)
    await refreshStoreSummaries()
    return loaded
  }, [storeCode, page, filter, sort, sortDirection, search, pageSize, loadListings, refreshStoreSummaries])

  const refreshAfterGuardUpdate = useCallback(async (): Promise<boolean> => {
    return refreshAfterPriceUpdate()
  }, [refreshAfterPriceUpdate])

  const refreshAfterAsinUpdate = useCallback(async (): Promise<boolean> => {
    return refreshAfterPriceUpdate()
  }, [refreshAfterPriceUpdate])

  const refreshAfterEndUpdate = useCallback(async (): Promise<boolean> => {
    return refreshAfterPriceUpdate()
  }, [refreshAfterPriceUpdate])

  useFocusRefetch(refreshStoreSummaries, { enabled: !loading })

  function clearListingSelection() {
    setSelectedByCatalogId(new Map())
  }

  function toggleListingSelection(item: AppListingItem) {
    const id = item.catalogStateId
    if (!id || id <= 0) return
    setSelectedByCatalogId(prev => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, item)
      return next
    })
  }

  function toggleSelectAllListingsOnPage() {
    if (allSelectableListingsSelected) {
      setSelectedByCatalogId(prev => {
        const next = new Map(prev)
        for (const item of selectableListings) {
          next.delete(item.catalogStateId)
        }
        return next
      })
      return
    }
    setSelectedByCatalogId(prev => {
      const next = new Map(prev)
      for (const item of selectableListings) {
        if (item.catalogStateId > 0) next.set(item.catalogStateId, item)
      }
      return next
    })
  }

  async function handleSetQuantity(item: AppListingItem, quantity: 0 | 1) {
    if (!storeCode || selectedStoreId == null || !canSetQuantity(item) || pendingQtyIds.has(item.catalogStateId)) return
    const previousQuantity = item.ebayQuantity
    const operationStoreId = selectedStoreId
    const operationStoreCode = storeCode
    const operationContextVersion = storeContextVersion.current
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 60_000)
    const isCurrentStore = () =>
      storeContextVersion.current === operationContextVersion &&
      selectedStoreIdRef.current === operationStoreId &&
      storeCodeRef.current === operationStoreCode
    setItems(prev => prev.map(row => row.catalogStateId === item.catalogStateId ? { ...row, ebayQuantity: quantity } : row))
    setPendingQtyIds(prev => new Set(prev).add(item.catalogStateId))
    document.querySelectorAll<HTMLDetailsElement>(".app-listing-actions details[open]").forEach(details => { details.open = false })
    setQtyBusyId(item.catalogStateId)
    setActionNotice(null)

    try {
      const result = await setAppListingQuantity({
        storeId: operationStoreId,
        catalogStateId: item.catalogStateId,
        quantity,
        confirm:        true,
        signal:         controller.signal,
      })

      if (!isCurrentStore()) return
      if (!result.ok) {
        if (result.status === 401) {
          router.replace("/app/login")
          return
        }
        if (result.status === 403 && result.approvalStatus === "pending_approval") {
          router.replace("/pending-approval")
          return
        }
        const msg = result.error?.trim()
        setItems(prev => prev.map(row => row.catalogStateId === item.catalogStateId ? { ...row, ebayQuantity: previousQuantity } : row))
        setActionNotice({
          kind: "error",
          text:
            msg && msg.length <= 260 && !/stack|trace|oauth|token/i.test(msg)
              ? msg
              : `Could not set quantity to ${quantity}.`,
        })
        return
      }

      setActionNotice({ kind: "ok", text: `Quantity set to ${quantity}.` })
    } catch (e) {
      if (!isCurrentStore()) return
      setItems(prev => prev.map(row => row.catalogStateId === item.catalogStateId ? { ...row, ebayQuantity: previousQuantity } : row))
      setActionNotice({
        kind: "error",
        text: controller.signal.aborted
          ? "Quantity request timed out. The server may still be finishing; do not resubmit."
          : (e instanceof Error ? e.message : `Could not set quantity to ${quantity}.`).slice(0, 300),
      })
    } finally {
      window.clearTimeout(timeoutId)
      if (isCurrentStore()) {
        setQtyBusyId(null)
        setPendingQtyIds(prev => { const next = new Set(prev); next.delete(item.catalogStateId); return next })
      }
    }
  }

  async function handleBulkSetQuantity(quantity: 0 | 1) {
    if (!storeCode || selectedStoreId == null || bulkQtyBusy) return
    const operationId = ++bulkQtyOperationSeq.current
    const operationStoreId = selectedStoreId
    const operationStoreCode = storeCode
    const operationContextVersion = storeContextVersion.current
    const ids = selectedListingItems
      .filter(canSetQuantity)
      .slice(0, BULK_LISTINGS_MAX)
      .map(i => i.catalogStateId)
    if (ids.length === 0) return

    const controller = new AbortController()
    // Three bounded workers can legitimately need up to roughly 235s for 47
    // worst-case 15s eBay operations; keep the client deadline finite but above that envelope.
    const timeoutId = window.setTimeout(() => controller.abort(), 300_000)
    activeBulkQtyOperation.current = operationId
    setBulkQtyBusy(true)
    setBulkQtyBusyQuantity(quantity)
    setBulkQtyBusyStoreId(operationStoreId)
    setActionNotice(null)

    const isCurrentStore = () =>
      storeContextVersion.current === operationContextVersion &&
      selectedStoreIdRef.current === operationStoreId &&
      storeCodeRef.current === operationStoreCode

    try {
      const result = await bulkSetAppListingQuantity({
        storeId: operationStoreId,
        catalogStateIds: ids,
        quantity,
        confirm: true,
        signal: controller.signal,
      })

      // The mutation request has ended; list refresh is not part of the busy state.
      if (activeBulkQtyOperation.current === operationId) {
        setBulkQtyBusy(false)
        setBulkQtyBusyQuantity(null)
        setBulkQtyBusyStoreId(null)
      }
      if (!isCurrentStore()) return

      if (!result.ok) {
        if (result.status === 401) {
          router.replace("/app/login")
          return
        }
        if (result.status === 403 && result.approvalStatus === "pending_approval") {
          router.replace("/pending-approval")
          return
        }
        const msg = result.error?.trim()
        setActionNotice({
          kind: "error",
          text:
            msg && msg.length <= 260 && !/stack|trace|oauth|token/i.test(msg)
              ? msg
              : "Could not set quantity to " + quantity + " for selected listings.",
        })
        return
      }

      const { succeeded, failed, uncertain, requested } = result.data
      const firstProblem = result.data.results.find(item => !item.ok)?.error?.trim()
      setItems(prev => prev.map(row => {
        const itemResult = result.data.results.find(item => item.catalogStateId === row.catalogStateId)
        return itemResult?.outcome === "succeeded" && itemResult.newQuantity != null
          ? { ...row, ebayQuantity: itemResult.newQuantity }
          : row
      }))
      setActionNotice({
        kind: failed > 0 || uncertain > 0 ? "error" : "ok",
        text:
          "Set Qty " + quantity + ": " + succeeded + "/" + requested + " updated" +
          (failed > 0 ? ", " + failed + " failed" : "") +
          (uncertain > 0 ? ", " + uncertain + " uncertain — do not resubmit" : "") +
          (firstProblem ? ". " + firstProblem : "."),
      })
      clearListingSelection()

      let refreshed = false
      try {
        refreshed = await refreshAfterPriceUpdate()
      } catch {
        refreshed = false
      }
      if (isCurrentStore() && !refreshed) {
        setActionNotice(prev => ({
          kind: prev?.kind === "error" ? "error" : "ok",
          text: (prev?.text ?? ("Set Qty " + quantity + " completed.")) + " List refresh failed; confirmed row values were kept.",
        }))
      }
    } catch (e) {
      if (!isCurrentStore()) return
      const text = controller.signal.aborted
        ? "Bulk quantity request timed out. The server may still be finishing; do not resubmit. Check the rows after refresh."
        : (e instanceof Error ? e.message : "Bulk quantity request failed.")
      setActionNotice({ kind: "error", text: text.slice(0, 300) })
    } finally {
      window.clearTimeout(timeoutId)
      if (activeBulkQtyOperation.current === operationId) {
        activeBulkQtyOperation.current = null
        setBulkQtyBusy(false)
        setBulkQtyBusyQuantity(null)
        setBulkQtyBusyStoreId(null)
      }
    }
  }

  function exportSelectedListings() {
    if (!storeCode || selectedByCatalogId.size === 0) return
    const selected = [...selectedByCatalogId.values()]
    if (selected.length === 0) return
    const csv = buildUserSelectedListingsCsv(
      selected.map(item => ({
        catalogStateId:    item.catalogStateId,
        title:             item.title,
        asin:              item.asin,
        ebayItemId:        item.ebayItemId,
        ebayPrice:         item.ebayPrice,
        sourcePrice:       item.sourcePrice,
        sourcePriceSource: item.sourcePriceSource,
        ebayQuantity:      item.ebayQuantity,
        status:            item.status,
        stockGuardEnabled: item.stockGuardEnabled,
        updatedAt:         item.updatedAt,
      }))
    )
    downloadCsvFile(csv, formatUserSelectedListingsFilename(storeCode))
  }

  function handleStoreChange(storeIdRaw: string) {
    const id = Number(storeIdRaw)
    const store = stores.find(s => s.storeId === id)
    if (!store) return
    clearListingSelection()
    listingsAbortRef.current?.abort()
    setItems([])
    setTotal(0)
    setSelectedStoreId(id)
    setStoreCode(store.storeCode)
    setPage(1)
    void loadImportStatus(store.storeId)
    syncListingsUrl(store.storeCode, filter, 1)
  }

  function handleFilterChange(next: AppListingsFilter) {
    clearListingSelection()
    setFilter(next)
    setPage(1)
    syncListingsUrl(storeCode, next, 1)
  }

  function handlePageChange(next: number) {
    if (next < 1) return
    const maxPage = Math.max(1, Math.ceil(total / pageSize))
    if (next > maxPage) return
    setPage(next)
    syncListingsUrl(storeCode, filter, next)
  }

  function closePriceModal() {
    setPriceModalItem(null)
    setPriceData(null)
    setPriceError(null)
    setPriceLoading(false)
  }

  async function openPriceModal(item: AppListingItem) {
    if (!storeCode || !item.catalogStateId || !hasAsin(item)) return

    setPriceModalItem(item)
    setPriceLoading(true)
    setPriceError(null)
    setPriceData(null)

    const result = await fetchAppRecommendedPrice(storeCode, item.catalogStateId)
    setPriceLoading(false)

    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      if (result.status === 403 && result.approvalStatus === "pending_approval") {
        router.replace("/pending-approval")
        return
      }
      setPriceError("Could not load price suggestion.")
      return
    }

    setPriceData(result.data)
  }

  if (loading && !hasLoadedOnce) {
    return (
      <div className="lj-listings">
        <div className="lj-state">
          <div className="lj-state-title">Loading listings</div>
          <div className="lj-state-body">Fetching the current store from eBay.</div>
        </div>
      </div>
    )
  }

  if (!user) return null

  const hasStores = stores.length > 0
  const listingCount = selectedStore?.listingCount ?? 0
  const needAsinCount = selectedStore?.needsAsinCount ?? 0
  const linkedCount = Math.max(0, listingCount - needAsinCount)
  const linkedRate = listingCount > 0 ? (linkedCount / listingCount) * 100 : null
  const lastSyncLabel = fmtStamp(importStatus?.lastCatalogSyncAt)
  const storeHasListings = listingCount > 0
  const searchActive = Boolean(debouncedSearch.trim())
  const emptyTitle =
    !storeHasListings && filter === "all" && !searchActive
      ? "No listings"
      : searchActive || filter !== "all"
        ? "No matching listings"
        : filterEmpty.title
  const emptyBody =
    !storeHasListings && filter === "all" && !searchActive
      ? "This store has no listings yet. Sync from eBay to import."
      : searchActive || filter !== "all"
        ? filterEmpty.description || "Nothing matches the current search or filter."
        : filterEmpty.description

  return (
    <div className="lj-listings">
      <div className="lj-header">
        <div className="lj-title-block">
          <Link href="/app/dashboard" className="lj-crumb">
            Dashboard / Listings
          </Link>
          <h1 className="lj-title">My Listings</h1>
          {hasStores && selectedStore && (
            <p className="lj-meta">
              {fmtCount(listingCount)} listings
              {"  ·  "}
              {fmtCount(needAsinCount)} need ASIN
              {lastSyncLabel ? `  ·  Last sync: ${lastSyncLabel}` : ""}
            </p>
          )}
        </div>
        {hasStores && (
          <div className="lj-toolbar">
            <ListingsStoreSelect
              stores={stores}
              value={selectedStoreId != null ? String(selectedStoreId) : ""}
              onChange={handleStoreChange}
            />
            <input
              className="lj-search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search title / ASIN / eBay ID"
              aria-label="Search listings"
            />
            <div className="lj-filter">
              <select
                value={filter}
                onChange={e => handleFilterChange(e.target.value as AppListingsFilter)}
                aria-label="Filter listings"
              >
                {FILTER_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="lj-btn"
              onClick={() => void loadListings(storeCode, page, filter, sort, sortDirection, debouncedSearch, pageSize)}
              disabled={listLoading}
            >
              Refresh
            </button>
            <button
              type="button"
              className="lj-btn"
              onClick={() => void handleCatalogSync()}
              disabled={catalogSyncBusy || selectedStoreId == null}
              title="Pull current eBay inventory into this store (read-only sync)"
            >
              {catalogSyncBusy ? "Syncing…" : "Sync from eBay"}
            </button>
            <Link href={importAsinHref} className="lj-btn-primary">
              Link Amazon ASINs
            </Link>
            <Link href="/app/stores" className="lj-btn">
              Manage Stores
            </Link>
          </div>
        )}
      </div>

      {hasStores && selectedStore && (
        <div className="lj-kpi-row">
          <div className="lj-kpi">
            <div className="lj-kpi-top">
              <span className="lj-kpi-well lj-kpi-well--green" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </span>
              <span className="lj-kpi-label">Listings</span>
            </div>
            <div className="lj-kpi-value">{fmtCount(listingCount)}</div>
            <div className="lj-kpi-hint">Current store filter</div>
          </div>
          <div className="lj-kpi lj-kpi--warn">
            <div className="lj-kpi-top">
              <span className="lj-kpi-well lj-kpi-well--amber" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M8 2.6 14.2 13.4H1.8L8 2.6Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                  <path d="M8 6.6v3.2M8 11.6h.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </span>
              <span className="lj-kpi-label">Need ASIN</span>
            </div>
            <div className="lj-kpi-value lj-kpi-value--amber">{fmtCount(needAsinCount)}</div>
            <div className="lj-kpi-hint">From listings missing ASIN</div>
          </div>
          <div className="lj-kpi">
            <div className="lj-kpi-top">
              <span className="lj-kpi-well lj-kpi-well--blue" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M8 4.8v3.2l2 1.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </span>
              <span className="lj-kpi-label">ASIN Linked Rate</span>
            </div>
            <div className="lj-kpi-value">
              {linkedRate == null ? "—" : `${linkedRate.toFixed(1)}%`}
            </div>
            <div className="lj-kpi-hint">
              {listingCount > 0 ? `${fmtCount(linkedCount)} of ${fmtCount(listingCount)} listings` : "No listings in this store"}
            </div>
          </div>
          <div className="lj-kpi lj-kpi--warn">
            <div className="lj-kpi-top">
              <span className="lj-kpi-well lj-kpi-well--amber" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M8 5.6v3.1M8 10.7h.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </span>
              <span className="lj-kpi-label">Needs Attention</span>
            </div>
            <div className="lj-kpi-value lj-kpi-value--amber">{fmtCount(needAsinCount)}</div>
            <div className="lj-kpi-hint">Need ASIN · Source unavailable</div>
          </div>
        </div>
      )}

      {false && (
        <p>
          {pageAsinLinked} {pageNeedsAsin} {pageSourceTracked} {pageSourceMissing}
        </p>
      )}

      {error && (
        <div role="status" className="lj-banner lj-banner--error">
          <span>{error}</span>{" "}
          <button
            type="button"
            className="lj-btn"
            onClick={() => (hasStores ? void loadListings(storeCode, page, filter, sort, sortDirection, debouncedSearch, pageSize) : void init())}
          >
            Retry
          </button>
        </div>
      )}

      {hasStores && selectedStore?.connected && (
        selectedStore.marketingAccess
          ? selectedStore.marketingAccess.granted === false
          : selectedStore.hasMarketingScope === false
      ) && (
        <div role="status" className="lj-banner lj-banner--warn">
          Reklam yönetimi için eBay bağlantısını yenileyin.{" "}
          <Link href="/app/settings">Mağaza ayarları</Link>
        </div>
      )}

      {!hasStores ? (
        <NoStoreEmptyState
          description="Connect your eBay store to view and monitor your imported listings."
        />
      ) : listLoading && items.length === 0 ? (
        <div className="lj-state">
          <div className="lj-state-title">Loading listings</div>
          <div className="lj-state-body">Fetching the current store from eBay.</div>
        </div>
      ) : total === 0 ? (
        <div className="lj-state">
          <div className="lj-state-title">{emptyTitle}</div>
          <div className="lj-state-body">{emptyBody}</div>
          {filterEmpty.primaryHref && filterEmpty.primaryLabel && (
            <Link href={filterEmpty.primaryHref} className="lj-btn-primary">
              {filterEmpty.primaryLabel}
            </Link>
          )}
        </div>
      ) : (
        <>
          {filter !== "all" && (
            <p className="lj-filter-note">
              Showing {items.length} on this page · {total} matching listing{total === 1 ? "" : "s"} (server
              filter)
            </p>
          )}

          {actionNotice && (
            <div
              role="status"
              className={`lj-notice ${actionNotice.kind === "ok" ? "lj-notice--ok" : "lj-notice--err"}`}
            >
              {actionNotice.text}
            </div>
          )}

          {selectedListingsCount > 0 && (
            <div className="app-bulk-toolbar">
              <span className="app-bulk-toolbar-count">
                Selected: {selectedListingsCount} listing{selectedListingsCount === 1 ? "" : "s"}
                {selectedListingsCount > currentPageSelectedCount ? " across pages" : ""}
              </span>
              <button
                type="button"
                className="app-bulk-toolbar-btn app-bulk-toolbar-btn--primary"
                onClick={exportSelectedListings}
              >
                Export Selected
              </button>
              <button type="button" className="app-bulk-toolbar-btn" onClick={clearListingSelection}>
                Clear
              </button>
              <button
                type="button"
                className="app-bulk-toolbar-btn"
                disabled={!canOpenBulkGuard}
                title={
                  bulkGuardEligibleCount > BULK_LISTINGS_MAX
                    ? bulkOverLimitTitle(BULK_LISTINGS_MAX)
                    : "This only changes monitoring status."
                }
                onClick={() => setBulkGuardModal({ enabled: true })}
              >
                Enable Guard selected
              </button>
              <button
                type="button"
                className="app-bulk-toolbar-btn"
                disabled={!canOpenBulkGuard}
                title={
                  bulkGuardEligibleCount > BULK_LISTINGS_MAX
                    ? bulkOverLimitTitle(BULK_LISTINGS_MAX)
                    : "This only changes monitoring status."
                }
                onClick={() => setBulkGuardModal({ enabled: false })}
              >
                Disable Guard selected
              </button>
              <button
                type="button"
                className="app-bulk-toolbar-btn"
                disabled={!canOpenBulkSetQty}
                title={
                  bulkSetQtyEligibleCount > BULK_LISTINGS_MAX
                    ? bulkOverLimitTitle(BULK_LISTINGS_MAX)
                    : "Sets eBay quantity to 1 for eligible selected listings."
                }
                onClick={() => void handleBulkSetQuantity(1)}
              >
                {bulkQtyWorkingFor(1) ? "Working…" : "Set Qty 1 selected"}
              </button>
              <button
                type="button"
                className="app-bulk-toolbar-btn"
                disabled={!canOpenBulkSetQty}
                title={
                  bulkSetQtyEligibleCount > BULK_LISTINGS_MAX
                    ? bulkOverLimitTitle(BULK_LISTINGS_MAX)
                    : "Sets eBay quantity to 0 for eligible selected listings."
                }
                onClick={() => void handleBulkSetQuantity(0)}
              >
                {bulkQtyWorkingFor(0) ? "Working…" : "Set Qty 0 selected"}
              </button>
              <button
                type="button"
                className="app-bulk-toolbar-btn"
                disabled={selectedListingsCount === 0 || selectedListingsCount > BULK_LISTINGS_MAX}
                title={
                  selectedListingsCount > BULK_LISTINGS_MAX
                    ? bulkOverLimitTitle(BULK_LISTINGS_MAX)
                    : "Seçilen canlı listinglere aynı reklam oranını uygular"
                }
                onClick={() => setBulkPromoOpen(true)}
              >
                Seçilenlere reklam uygula
              </button>
              <button
                type="button"
                className="app-bulk-toolbar-btn app-bulk-toolbar-btn--danger"
                disabled={!canOpenBulkHide}
                title={
                  bulkHideEligibleCount > BULK_LISTINGS_MAX
                    ? bulkOverLimitTitle(BULK_LISTINGS_MAX)
                    : "This does not end eBay listings."
                }
                onClick={() => setBulkHideModalOpen(true)}
              >
                Hide selected
              </button>
              <button
                type="button"
                className="app-bulk-toolbar-btn app-bulk-toolbar-btn--danger"
                disabled={!canOpenBulkEnd}
                title="Ends eligible selected listings on eBay."
                onClick={() => setBulkEndModalOpen(true)}
              >
                End selected
              </button>
              {(bulkGuardEligibleCount > BULK_LISTINGS_MAX ||
                bulkHideEligibleCount > BULK_LISTINGS_MAX) && (
                <span className="app-bulk-toolbar-hint">
                  Max {BULK_LISTINGS_MAX} per batch for Guard / Hide
                </span>
              )}
            </div>
          )}

          <div className="lj-main">
          <div className="lj-table-card">
          <div className="app-listings-table-wrap">

            <table className="app-listings-table">
              <thead>
                <tr>
                  <th>
                    <input
                      ref={selectAllListingsRef}
                      type="checkbox"
                      className="app-table-checkbox"
                      checked={allSelectableListingsSelected && selectableListings.length > 0}
                      disabled={selectableListings.length === 0 || listLoading}
                      onChange={toggleSelectAllListingsOnPage}
                      aria-label="Select all listings on this page"
                    />
                  </th>
                  <th>{sortHeader("Listing", "title")}</th>
                  <th>{sortHeader("ASIN", "asin")}</th>
                  <th>Source</th>
                  <th>eBay ID</th>
                  <th>{sortHeader("eBay $", "ebayPrice")}</th>
                  <th>{sortHeader("Source $", "sourcePrice")}</th>
                  <th>{sortHeader("Qty", "quantity")}</th>
                  <th>{sortHeader("Status", "status")}</th>
                  <th>{sortHeader("Upload Date", "listedAt")}</th>
                  <th>{sortHeader("Sold", "totalSold")}</th>
                  <th>{sortHeader("30D Clicks", "clicks30d")}</th>
                  <th>{sortHeader("Guard", "stockGuard")}</th>
                  <th>{sortHeader("Profit Prot.", "profitProtection")}</th>
                  <th>{sortHeader("Updated", "updated")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && !listLoading ? (
                  <tr><td colSpan={16}><div className="lj-state"><div className="lj-state-title">No matching listings</div><div className="lj-state-body">Nothing matches the current search or filter.</div></div></td></tr>
                ) : items.map(item => (
                  <ListingRow
                    key={item.catalogStateId}
                    item={item}
                    importAsinHref={importAsinHref}
                    selected={selectedByCatalogId.has(item.catalogStateId)}
                    onToggleSelect={() => toggleListingSelection(item)}
                    onOpenPriceSuggestion={() => void openPriceModal(item)}
                    onOpenGuardModal={enabled =>
                      setGuardModalItem({ item, enabled })
                    }
                    onOpenAsinModal={() => setAsinModalItem(item)}
                    onOpenEndModal={() => setEndModalItem(item)}
                    onOpenPromoModal={() => setPromoModalItem(item)}
                    marketingGranted={selectedStore?.marketingAccess?.granted ?? selectedStore?.hasMarketingScope !== false}
                    onSetQty={quantity => void handleSetQuantity(item, quantity)}
                    qtyBusy={pendingQtyIds.has(item.catalogStateId)}
                    anyQtyBusy={pendingQtyIds.has(item.catalogStateId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          </div>
          </div>
          <div className="lj-pager">
            <span>
              Page {page} of {totalPages} · {total} listing{total === 1 ? "" : "s"}
            </span>
            <div className="lj-pager-controls">
              <label>
                Rows:{" "}
                <select
                  value={pageSize}
                  aria-label="Rows per page"
                  onChange={e => { const next = Number(e.target.value); setPageSize(next); setPage(1) }}
                >
                  {PAGE_SIZE_OPTIONS.map(size => <option key={size} value={size}>{size}</option>)}
                </select>
              </label>
              <button
                type="button"
                className="lj-btn"
                onClick={() => handlePageChange(page - 1)}
                disabled={page <= 1 || listLoading}
              >
                Prev
              </button>
              <button
                type="button"
                className="lj-btn"
                onClick={() => handlePageChange(page + 1)}
                disabled={page >= totalPages || listLoading}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}

      {priceModalItem && (
        <RecommendedPriceModal
          item={priceModalItem}
          storeCode={storeCode}
          loading={priceLoading}
          error={priceError}
          data={priceData}
          onClose={closePriceModal}
          onUpdateSuccess={refreshAfterPriceUpdate}
        />
      )}

      {guardModalItem && (
        <StockGuardModal
          item={guardModalItem.item}
          storeCode={storeCode}
          enabled={guardModalItem.enabled}
          onClose={() => setGuardModalItem(null)}
          onSuccess={refreshAfterGuardUpdate}
        />
      )}

      {bulkGuardModal && storeCode && (
        <BulkStockGuardModal
          storeCode={storeCode}
          enabled={bulkGuardModal.enabled}
          selectedItems={selectedListingItems}
          eligibleCount={bulkGuardEligibleCount}
          ineligibleCount={bulkGuardIneligibleCount}
          onClose={() => setBulkGuardModal(null)}
          onSuccess={async () => {
            setBulkGuardModal(null)
            clearListingSelection()
            await refreshAfterGuardUpdate()
          }}
          onViewGuardOn={() => {
            setBulkGuardModal(null)
            clearListingSelection()
            handleFilterChange("guard-on")
          }}
          onViewGuardOff={() => {
            setBulkGuardModal(null)
            clearListingSelection()
            handleFilterChange("guard-off")
          }}
        />
      )}

      {bulkHideModalOpen && storeCode && (
        <BulkHideListingsModal
          storeCode={storeCode}
          selectedItems={selectedListingItems}
          eligibleCount={bulkHideEligibleCount}
          onClose={() => setBulkHideModalOpen(false)}
          onSuccess={async () => {
            setBulkHideModalOpen(false)
            clearListingSelection()
            await refreshAfterGuardUpdate()
          }}
          onViewListings={() => {
            setBulkHideModalOpen(false)
            clearListingSelection()
            void refreshAfterGuardUpdate()
          }}
        />
      )}

      {bulkEndModalOpen && storeCode && (
        <BulkEndListingsModal
          storeCode={storeCode}
          selectedItems={selectedListingItems}
          eligibleCount={bulkEndEligibleCount}
          ineligibleCount={bulkEndIneligibleCount}
          onClose={() => setBulkEndModalOpen(false)}
          onSuccess={async () => {
            setBulkEndModalOpen(false)
            clearListingSelection()
            await refreshAfterEndUpdate()
          }}
          onViewListings={() => {
            setBulkEndModalOpen(false)
            clearListingSelection()
            void refreshAfterEndUpdate()
          }}
        />
      )}

      {asinModalItem && (
        <UpdateSourceAsinModal
          item={asinModalItem}
          storeCode={storeCode}
          onClose={() => setAsinModalItem(null)}
          onSuccess={refreshAfterAsinUpdate}
        />
      )}

      {endModalItem && (
        <EndListingModal
          item={endModalItem}
          storeCode={storeCode}
          onClose={() => setEndModalItem(null)}
          onSuccess={refreshAfterEndUpdate}
        />
      )}

      {promoModalItem && (
        <ListingPromotionModal
          item={promoModalItem}
          storeCode={storeCode}
          storeId={selectedStoreId ?? undefined}
          marketingGranted={selectedStore?.marketingAccess?.granted ?? selectedStore?.hasMarketingScope !== false}
          onClose={() => setPromoModalItem(null)}
          onSuccess={async () => {
            setPromoModalItem(null)
            await refreshAfterEndUpdate()
          }}
        />
      )}

      {bulkPromoOpen && storeCode && (
        <BulkListingPromotionModal
          storeCode={storeCode}
          storeId={selectedStoreId ?? undefined}
          selectedItems={selectedListingItems}
          onClose={() => setBulkPromoOpen(false)}
          onSuccess={async () => {
            setBulkPromoOpen(false)
            clearListingSelection()
            await refreshAfterEndUpdate()
          }}
        />
      )}
    </div>
  )
}

function canToggleStockGuard(item: AppListingItem): boolean {
  if (!item.catalogStateId || item.catalogStateId <= 0) return false
  return item.status?.trim().toLowerCase() !== "ended"
}

function canEndListing(item: AppListingItem): boolean {
  if (!item.catalogStateId || item.catalogStateId <= 0) return false
  if (item.status?.trim().toLowerCase() === "ended") return false
  // eBay ID is no longer required: listings without an eBay item ID are ended
  // locally (panel cleanup) instead of being blocked.
  return true
}

// Set Qty 0 / Set Qty 1 require an eBay item to push the quantity to.
function promotionBadgeLabel(item: AppListingItem): string {
  const p = item.promotion
  if (!p || p.status === "UNKNOWN") return "Bilinmiyor"
  if (p.status === "OFF" || (!p.requested && p.status !== "ACTIVE")) return "Kapalı"
  if (p.status === "PENDING") return "Bekliyor"
  if (p.status === "FAILED") return "Hata"
  if (p.status === "ACTIVE" && p.effectiveRate != null) return `%${p.effectiveRate} Aktif`
  if (p.status === "ACTIVE") return "Aktif"
  return "Bilinmiyor"
}

function promotionBadgeVariant(item: AppListingItem): "ok" | "warn" | "dim" | "info" {
  const p = item.promotion
  if (!p || p.status === "UNKNOWN") return "dim"
  if (p.status === "ACTIVE") return "ok"
  if (p.status === "FAILED" || p.status === "PENDING") return "warn"
  return "dim"
}

function canSetQuantity(item: AppListingItem): boolean {
  if (!item.catalogStateId || item.catalogStateId <= 0) return false
  if (item.status?.trim().toLowerCase() === "ended") return false
  return Boolean(item.ebayItemId?.trim())
}

function isListingEnded(item: AppListingItem): boolean {
  return item.status?.trim().toLowerCase() === "ended"
}

function ListingRow({
  item,
  importAsinHref,
  selected,
  onToggleSelect,
  onOpenPriceSuggestion,
  onOpenGuardModal,
  onOpenAsinModal,
  onOpenEndModal,
  onOpenPromoModal,
  marketingGranted,
  onSetQty,
  qtyBusy,
  anyQtyBusy,
}: {
  item: AppListingItem
  importAsinHref: string
  selected: boolean
  onToggleSelect: () => void
  onOpenPriceSuggestion: () => void
  onOpenGuardModal: (enabled: boolean) => void
  onOpenAsinModal: () => void
  onOpenEndModal: () => void
  onOpenPromoModal: () => void
  marketingGranted: boolean
  onSetQty: (quantity: 0 | 1) => void
  qtyBusy: boolean
  anyQtyBusy: boolean
}) {
  const actionsButtonRef = useRef<HTMLButtonElement>(null)
  const actionsMenuRef = useRef<HTMLDivElement>(null)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [actionsPosition, setActionsPosition] = useState<CSSProperties>({ visibility: "hidden" })
  const asinLinked = hasAsin(item)
  const sourceLabel = item.sourceStatus?.trim() || (hasSourceTracked(item) ? "Source tracked" : "Source missing")
  const sourceReason = item.sourceStatusReason?.trim() || null
  const needsAsin = !asinLinked
  const canAsinModal = item.catalogStateId > 0
  const canSelect = item.catalogStateId > 0
  const ended = isListingEnded(item)
  const endEnabled = canEndListing(item)
  const qtyEnabled = canSetQuantity(item)
  const canSuggestPrice = asinLinked && item.catalogStateId > 0
  const displayAsin = normalizeDisplayAsin(item.asin)
  const amazonUrl = safeAmazonUrlFromAsin(item.asin)
  const ebayUrl = safeEbayListingUrl(item.ebayItemId)

  const protectedLabel = item.autoPriceProtectedAt ? "Protected" : "—"

  const guardOn = item.stockGuardEnabled !== false
  const guardToggleEnabled = canToggleStockGuard(item)

  const listedParts = fmtDateParts(item.listedAt)
  const statusKey = item.status?.trim().toLowerCase() ?? ""
  const liveStatus = statusKey === "live" || statusKey === "active"

  useEffect(() => {
    if (!actionsOpen) return

    const positionMenu = () => {
      const button = actionsButtonRef.current
      if (!button) return
      const rect = button.getBoundingClientRect()
      const menuHeight = actionsMenuRef.current?.offsetHeight ?? 440
      const openUpward = window.innerHeight - rect.bottom < Math.min(menuHeight, 440) && rect.top > window.innerHeight - rect.bottom

      setActionsPosition({
        position: "fixed",
        right: Math.max(12, window.innerWidth - rect.right),
        visibility: "visible",
        ...(openUpward
          ? { bottom: Math.max(12, window.innerHeight - rect.top + 8) }
          : { top: rect.bottom + 8 }),
      })
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (!actionsButtonRef.current?.contains(target) && !actionsMenuRef.current?.contains(target)) {
        setActionsOpen(false)
      }
    }

    positionMenu()
    requestAnimationFrame(positionMenu)
    window.addEventListener("resize", positionMenu)
    window.addEventListener("scroll", positionMenu, true)
    document.addEventListener("mousedown", closeOnOutsideClick)
    return () => {
      window.removeEventListener("resize", positionMenu)
      window.removeEventListener("scroll", positionMenu, true)
      document.removeEventListener("mousedown", closeOnOutsideClick)
    }
  }, [actionsOpen])

  return (
    <tr className={selected ? "app-listing-row app-listing-row--selected" : "app-listing-row"}>
      <td>
        <input
          type="checkbox"
          className="app-table-checkbox"
          checked={selected}
          disabled={!canSelect}
          onChange={onToggleSelect}
          aria-label={`Select listing ${item.catalogStateId}`}
        />
      </td>
      <td>
        <div className="lj-product">
          {item.imageUrl ? (
            <img
              src={item.imageUrl}
              alt=""
              loading="lazy"
              className="lj-thumb"
              onError={event => {
                event.currentTarget.style.opacity = "0"
              }}
            />
          ) : (
            <div className="lj-thumb-empty" aria-hidden="true" />
          )}
          <div className="lj-product-copy" title={dash(item.title)}>
            <div className="lj-product-title">{dash(item.title)}</div>
            <div className="lj-product-sub">
              {displayAsin ? displayAsin : "—"}
              {item.ebayItemId ? ` · eBay ${item.ebayItemId}` : ""}
            </div>
          </div>
        </div>
      </td>
      <td>
        <div className="lj-asin-stack">
          <StatusBadge label={asinLinked ? "ASIN linked" : "Needs ASIN"} variant={asinLinked ? "ok" : "warn"} />
          {amazonUrl ? (
            <a href={amazonUrl} target="_blank" rel="noreferrer" className="lj-asin-code">
              {displayAsin ?? "Amazon"}
            </a>
          ) : (
            <span className={asinLinked ? "lj-asin-code" : "lj-asin-code lj-asin-code--muted"}>
              {displayAsin ?? "Not linked"}
            </span>
          )}
        </div>
      </td>
      <td>
        <div className="lj-source-stack">
          <StatusBadge
            label={sourceLabel}
            variant={sourceBadgeVariant(item)}
          />
          {sourceReason && (
            <div title={sourceReason} className="lj-source-reason">
              {sourceReason.length > 90 ? `${sourceReason.slice(0, 89)}…` : sourceReason}
            </div>
          )}
        </div>
      </td>
      <td>
        {item.ebayItemId ? (
          ebayUrl ? (
            <a href={ebayUrl} target="_blank" rel="noreferrer" className="lj-ebay-id" title={item.ebayItemId}>
              {item.ebayItemId}
            </a>
          ) : (
            <span className="lj-ebay-id">{item.ebayItemId}</span>
          )
        ) : (
          "—"
        )}
      </td>
      <td className="lj-price">{fmtPrice(item.ebayPrice)}</td>
      <td className="lj-source-price">
        {item.sourceStatus?.trim().toUpperCase() === "UNAVAILABLE" && item.sourcePrice == null
          ? "—"
          : fmtPrice(item.sourcePrice)}
      </td>
      <td className={item.ebayQuantity === 0 ? "lj-qty lj-qty--zero" : "lj-qty"}>
        {dash(item.ebayQuantity)} {qtyBusy && <span title="Syncing quantity" className="lj-qty-sync">syncing…</span>}
      </td>
      <td>
        <div className="lj-status-stack">
          {ended ? (
            <StatusBadge label="Ended" variant="dim" />
          ) : liveStatus ? (
            <StatusBadge label="Live" variant="ok" />
          ) : (
            <StatusBadge label={item.status?.trim() || "unknown"} variant="dim" />
          )}
          <span title={item.promotion?.message || undefined}>
            <StatusBadge
              label={promotionBadgeLabel(item)}
              variant={promotionBadgeVariant(item)}
            />
          </span>
        </div>
      </td>
      <td>
        {listedParts ? (
          <div className="lj-date-stack">
            <span className="lj-date">{listedParts.date}</span>
            <span className="lj-time">{listedParts.time}</span>
          </div>
        ) : (
          "—"
        )}
      </td>
      <td className="lj-metric">{formatSoldCount(item.totalSold)}</td>
      <td className="lj-metric" title={item.clicks30dCheckedAt ? `Checked ${fmtDate(item.clicks30dCheckedAt)}` : undefined}>{dash(item.clicks30d)}</td>
      <td>
        <StatusBadge
          label={guardOn ? "Guard On" : "Guard Off"}
          variant={guardOn ? "ok" : "dim"}
        />
      </td>
      <td>{protectedLabel}</td>
      <td>{fmtDate(item.updatedAt)}</td>
      <td className="app-listing-actions lj-row-action" style={{ overflow: "visible", position: "relative" }}>
        <button
          ref={actionsButtonRef}
          type="button"
          className="lj-row-action-trigger"
          aria-label="Listing actions"
          title="Actions"
          aria-haspopup="menu"
          aria-expanded={actionsOpen}
          onClick={() => setActionsOpen(open => !open)}
        >
          <span aria-hidden="true">•••</span>
        </button>

        {actionsOpen && createPortal(
          <div
            ref={actionsMenuRef}
            className="lj-row-action-menu"
            role="menu"
            style={actionsPosition}
            onClick={event => {
              if ((event.target as HTMLElement).closest("button, a")) setActionsOpen(false)
            }}
          >
            <button
              type="button"
              onClick={onOpenPriceSuggestion}
              disabled={!canSuggestPrice}
              title={canSuggestPrice ? "View recommended price" : "Link ASIN first to view price suggestion"}
              style={{
                ...actionBtnStyle,
                width: "100%",
                textAlign: "left",
                opacity: canSuggestPrice ? 1 : 0.5,
                cursor: canSuggestPrice ? "pointer" : "not-allowed",
              }}
            >
              View Price
            </button>

            {needsAsin && item.ebayItemId && canAsinModal && (
              <button type="button" onClick={onOpenAsinModal} style={{ ...actionBtnStyle, width: "100%", textAlign: "left" }}>
                Link ASIN
              </button>
            )}

            {needsAsin && item.ebayItemId && (
              <Link href={importAsinHref} style={{ ...linkAsinBtnStyle, width: "100%", boxSizing: "border-box" }}>
                Bulk ASIN match
              </Link>
            )}

            {asinLinked && canAsinModal && (
              <button type="button" onClick={onOpenAsinModal} style={{ ...actionBtnStyle, width: "100%", textAlign: "left" }}>
                Update ASIN
              </button>
            )}

            {ebayUrl && (
              <a href={ebayUrl} target="_blank" rel="noreferrer" style={{ ...externalLinkBtnStyle, width: "100%", boxSizing: "border-box" }}>
                Open eBay
              </a>
            )}

            {amazonUrl && (
              <a href={amazonUrl} target="_blank" rel="noreferrer" style={{ ...externalLinkBtnStyle, width: "100%", boxSizing: "border-box" }}>
                Open Amazon
              </a>
            )}

            {guardToggleEnabled && (
              <button
                type="button"
                onClick={() => onOpenGuardModal(!guardOn)}
                style={{ ...actionBtnStyle, width: "100%", textAlign: "left" }}
              >
                {guardOn ? "Disable Guard" : "Enable Guard"}
              </button>
            )}

            {item.ebayItemId && !ended && (
              <>
                <button
                  type="button"
                  onClick={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    onOpenPromoModal()
                  }}
                  title={marketingGranted ? "Reklamı aç" : "eBay bağlantısını yenileyin"}
                  style={{ ...actionBtnStyle, width: "100%", textAlign: "left" }}
                >
                  Reklamı aç
                </button>
                <button
                  type="button"
                  onClick={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    onOpenPromoModal()
                  }}
                  title={marketingGranted ? "Reklam oranını değiştir" : "eBay bağlantısını yenileyin"}
                  style={{ ...actionBtnStyle, width: "100%", textAlign: "left" }}
                >
                  Reklam oranını değiştir
                </button>
                <button
                  type="button"
                  onClick={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    onOpenPromoModal()
                  }}
                  title={marketingGranted ? "Reklamı kapat" : "eBay bağlantısını yenileyin"}
                  style={{ ...actionBtnStyle, width: "100%", textAlign: "left" }}
                >
                  Reklamı kapat
                </button>
                <button
                  type="button"
                  onClick={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    onOpenPromoModal()
                  }}
                  title={marketingGranted ? "Reklamı tekrar dene" : "eBay bağlantısını yenileyin"}
                  style={{ ...actionBtnStyle, width: "100%", textAlign: "left" }}
                >
                  Reklamı tekrar dene
                </button>
                <button
                  type="button"
                  onClick={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    onOpenPromoModal()
                  }}
                  title={marketingGranted ? "eBay’den doğrula" : "eBay bağlantısını yenileyin"}
                  style={{ ...actionBtnStyle, width: "100%", textAlign: "left" }}
                >
                  eBay’den doğrula
                </button>
              </>
            )}

            {qtyEnabled && (
              <button
                type="button"
                onClick={() => onSetQty(1)}
                disabled={anyQtyBusy}
                style={{
                  ...actionBtnStyle,
                  width: "100%",
                  textAlign: "left",
                  opacity: anyQtyBusy ? 0.5 : 1,
                }}
              >
                {qtyBusy ? "Working…" : "Set Qty 1"}
              </button>
            )}

            {qtyEnabled && (
              <button
                type="button"
                onClick={() => onSetQty(0)}
                disabled={anyQtyBusy}
                style={{
                  ...actionBtnStyle,
                  width: "100%",
                  textAlign: "left",
                  opacity: anyQtyBusy ? 0.5 : 1,
                }}
              >
                {qtyBusy ? "Working…" : "Set Qty 0"}
              </button>
            )}

            <div style={{ fontSize: 10, color: "var(--dim)", padding: "3px 5px" }}>
              Profit protection: {protectedLabel}
            </div>

            {endEnabled && (
              <button
                type="button"
                className="lj-row-action-danger"
                onClick={onOpenEndModal}
                style={{
                  ...actionBtnStyle,
                  width: "100%",
                  textAlign: "left",
                  color: "#f87171",
                  borderColor: "rgba(248, 113, 113, 0.35)",
                }}
              >
                End Listing
              </button>
            )}
          </div>,
          document.body
        )}
      </td>
    </tr>
  )
}

function BulkHideListingsModal({
  storeCode,
  selectedItems,
  eligibleCount,
  onClose,
  onSuccess,
  onViewListings,
}: {
  storeCode:     string
  selectedItems: AppListingItem[]
  eligibleCount: number
  onClose:       () => void
  onSuccess:     () => Promise<void>
  onViewListings: () => void
}) {
  const router = useRouter()
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [belowRecommendedChecked, setBelowRecommendedChecked] = useState(false)
  const [customPrice, setCustomPrice] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AppBulkHideListingsResponse | null>(null)

  const selectedCount = selectedItems.length
  const skippedCount = Math.max(0, selectedCount - eligibleCount)
  const overLimit = eligibleCount > BULK_LISTINGS_MAX

  const catalogStateIdsToSend = useMemo(
    () =>
      selectedItems
        .filter(item => item.catalogStateId > 0)
        .slice(0, BULK_LISTINGS_MAX)
        .map(item => item.catalogStateId),
    [selectedItems]
  )

  async function handleSubmit() {
    if (!confirmChecked || loading || eligibleCount === 0 || overLimit) return
    setLoading(true)
    setError(null)

    const apiResult = await bulkHideAppListings({
      storeCode,
      catalogStateIds: catalogStateIdsToSend,
      confirm:         true,
    })

    setLoading(false)

    if (!apiResult.ok) {
      if (apiResult.status === 401) {
        router.replace("/app/login")
        return
      }
      if (apiResult.status === 403 && apiResult.approvalStatus === "pending_approval") {
        router.replace("/pending-approval")
        return
      }
      const msg = apiResult.error?.trim()
      setError(
        msg && msg.length <= 120 && !/stack|trace|oauth|token/i.test(msg)
          ? msg
          : "Could not hide selected listings."
      )
      return
    }

    setResult(apiResult.data)
  }

  async function handleCloseAfterSuccess() {
    await onSuccess()
  }

  if (result) {
    const failedItems = result.results.filter(r => !r.ok)
    return (
      <div className="app-modal-overlay" onClick={() => void handleCloseAfterSuccess()} role="presentation">
        <div
          className="app-modal"
          role="dialog"
          aria-labelledby="bulk-hide-result-title"
          onClick={e => e.stopPropagation()}
        >
          <div className="app-modal-header">
            <div>
              <h2 id="bulk-hide-result-title" className="app-modal-title">
                Bulk hide complete
              </h2>
              <p className="app-modal-subtitle">
                Selected listings were hidden from your panel. eBay listings were not ended or changed.
              </p>
            </div>
            <button
              type="button"
              className="app-modal-close-x"
              onClick={() => void handleCloseAfterSuccess()}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <ul className="app-modal-summary-list">
            <li>Requested: {result.requested}</li>
            <li>Succeeded: {result.succeeded}</li>
            <li>Failed: {result.failed}</li>
          </ul>

          <p className="app-modal-meta">
            {getBulkResultOutcomeMessage(result.requested, result.succeeded, result.failed)}
          </p>
          {result.batchId && (
            <p className="app-modal-meta" style={{ fontSize: 12 }}>
              {formatBulkBatchRef(result.batchId)}
            </p>
          )}

          {failedItems.length > 0 && failedItems.length <= 5 && (
            <ul className="app-modal-summary-list" style={{ marginTop: 8 }}>
              {failedItems.map(item => (
                <li key={item.catalogStateId}>
                  Listing #{item.catalogStateId}: {item.error ?? "Could not hide."}
                </li>
              ))}
            </ul>
          )}

          <div className="app-modal-footer app-modal-footer-actions">
            <button
              type="button"
              className="app-modal-close-btn"
              onClick={() => void handleCloseAfterSuccess()}
            >
              Close
            </button>
            <button type="button" className="app-modal-primary-btn" onClick={onViewListings}>
              View Listings
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="app-modal"
        role="dialog"
        aria-labelledby="bulk-hide-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="bulk-hide-title" className="app-modal-title">
              Hide selected listings from panel?
            </h2>
            <p className="app-modal-subtitle">
              This will only hide selected listings from your ListJetGo panel. It will not end your eBay
              listings, change quantity, or change price.
            </p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="app-modal-warning" style={{ marginBottom: 12 }}>
          This is not the same as End Listing. This does not end eBay listings.
        </p>

        <ul className="app-modal-summary-list">
          <li>Selected: {selectedCount}</li>
          <li>Eligible: {eligibleCount}</li>
          <li>Will be skipped: {skippedCount}</li>
          <li>Max allowed per batch: {BULK_LISTINGS_MAX}</li>
        </ul>

        {overLimit && (
          <p className="app-modal-warning">
            Select at most {BULK_LISTINGS_MAX} eligible listings per batch.
          </p>
        )}

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-apply-section">
          <h3 className="app-modal-apply-title">Confirm hide</h3>
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            I understand this only hides listings from the panel.
          </label>
        </div>

        <div className="app-modal-footer app-modal-footer-actions">
          <button type="button" className="app-modal-close-btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className="app-modal-primary-btn app-modal-danger-btn"
            disabled={!confirmChecked || eligibleCount === 0 || loading || overLimit}
            onClick={() => void handleSubmit()}
          >
            {loading ? "Hiding…" : "Hide Selected"}
          </button>
        </div>
      </div>
    </div>
  )
}

function BulkEndListingsModal({
  storeCode,
  selectedItems,
  eligibleCount,
  ineligibleCount,
  onClose,
  onSuccess,
  onViewListings,
}: {
  storeCode:       string
  selectedItems:   AppListingItem[]
  eligibleCount:   number
  ineligibleCount: number
  onClose:         () => void
  onSuccess:       () => Promise<void>
  onViewListings:  () => void
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AppBulkEndListingsResponse | null>(null)

  const catalogStateIdsToSend = useMemo(
    () =>
      selectedItems
        .filter(canEndListing)
        .map(item => item.catalogStateId),
    [selectedItems]
  )

  async function handleYes() {
    if (loading || eligibleCount <= 0) return
    setLoading(true)
    setError(null)
    try {
      const apiResult = await bulkEndAppListings({
        storeCode,
        catalogStateIds: catalogStateIdsToSend,
        confirm:         true,
      })

      if (!apiResult.ok) {
        if (apiResult.status === 401) {
          router.replace("/app/login")
          return
        }
        if (apiResult.status === 403 && apiResult.approvalStatus === "pending_approval") {
          router.replace("/pending-approval")
          return
        }
        const msg = apiResult.error?.trim()
        setError(
          msg && msg.length <= 120 && !/stack|trace|oauth|token/i.test(msg)
            ? msg
            : "Could not remove selected listings."
        )
        return
      }

      setResult(apiResult.data)
    } catch {
      setError("The result is unknown. Verify eBay and Listings before retrying.")
    } finally {
      setLoading(false)
    }
  }

  async function handleCloseAfterSuccess() {
    await onSuccess()
  }

  if (result) {
    const failedItems = result.results.filter(r => !r.ok)
    return (
      <div className="app-modal-overlay" onClick={() => void handleCloseAfterSuccess()} role="presentation">
        <div
          className="app-modal"
          role="dialog"
          aria-labelledby="bulk-end-result-title"
          onClick={e => e.stopPropagation()}
        >
          <div className="app-modal-header">
            <div>
              <h2 id="bulk-end-result-title" className="app-modal-title">
                {result.failed > 0 ? "Removal finished with failures" : "Removal complete"}
              </h2>
              <p className="app-modal-subtitle">
                {result.failed === 0
                  ? "Ended listings were removed from ListJetGo."
                  : result.succeeded > 0
                    ? "Successful listings were removed from ListJetGo. Failed items remain in the list."
                    : "No selected listings were removed. Failed items remain in the list."}
              </p>
            </div>
            <button
              type="button"
              className="app-modal-close-x"
              onClick={() => void handleCloseAfterSuccess()}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <ul className="app-modal-summary-list">
            <li>Requested: {result.requested}</li>
            <li>Succeeded: {result.succeeded}</li>
            <li>Failed: {result.failed}</li>
          </ul>

          <p className="app-modal-meta">
            {getBulkResultOutcomeMessage(result.requested, result.succeeded, result.failed)}
          </p>
          {result.failed > 0 && result.succeeded > 0 && (
            <p className="app-modal-meta">
              {result.failed} listing{result.failed === 1 ? "" : "s"} could not be removed.
            </p>
          )}
          {result.batchId && (
            <p className="app-modal-meta" style={{ fontSize: 12 }}>
              {formatBulkBatchRef(result.batchId)}
            </p>
          )}

          {failedItems.length > 0 && failedItems.length <= 5 && (
            <ul className="app-modal-summary-list" style={{ marginTop: 8 }}>
              {failedItems.map(item => (
                <li key={item.catalogStateId}>
                  Listing #{item.catalogStateId}: {item.error ?? "Could not remove listing."}
                </li>
              ))}
            </ul>
          )}

          <div className="app-modal-footer app-modal-footer-actions">
            <button
              type="button"
              className="app-modal-close-btn"
              onClick={() => void handleCloseAfterSuccess()}
            >
              Close
            </button>
            <button type="button" className="app-modal-primary-btn" onClick={onViewListings}>
              View Listings
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-modal-overlay" onClick={loading ? undefined : onClose} role="presentation">
      <div
        className="app-modal"
        role="dialog"
        aria-labelledby="bulk-end-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="bulk-end-title" className="app-modal-title">
              Remove selected listings?
            </h2>
            <p className="app-modal-subtitle">
              {eligibleCount === 1
                ? "1 listing will be ended on eBay and permanently removed from ListJetGo. Are you sure?"
                : `${eligibleCount} listings will be ended on eBay and permanently removed from ListJetGo. Are you sure?`}
            </p>
          </div>
          <button
            type="button"
            className="app-modal-close-x"
            onClick={onClose}
            disabled={loading}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {ineligibleCount > 0 && (
          <p className="app-modal-meta">{ineligibleCount} selected item{ineligibleCount === 1 ? "" : "s"} will be skipped.</p>
        )}

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-footer app-modal-footer-actions">
          <button type="button" className="app-modal-close-btn" onClick={onClose} disabled={loading}>
            No
          </button>
          <button
            type="button"
            className="app-modal-primary-btn app-modal-danger-btn"
            disabled={loading || eligibleCount <= 0}
            onClick={() => void handleYes()}
          >
            {loading ? "Removing…" : "Yes"}
          </button>
        </div>
      </div>
    </div>
  )
}

function BulkStockGuardModal({
  storeCode,
  enabled,
  selectedItems,
  eligibleCount,
  ineligibleCount,
  onClose,
  onSuccess,
  onViewGuardOn,
  onViewGuardOff,
}: {
  storeCode:       string
  enabled:         boolean
  selectedItems:   AppListingItem[]
  eligibleCount:   number
  ineligibleCount: number
  onClose:         () => void
  onSuccess:       () => Promise<void>
  onViewGuardOn:   () => void
  onViewGuardOff:  () => void
}) {
  const router = useRouter()
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AppBulkListingStockGuardResponse | null>(null)

  const selectedCount = selectedItems.length
  const skippedCount = ineligibleCount
  const overLimit = eligibleCount > BULK_LISTINGS_MAX

  const catalogStateIdsToSend = useMemo(
    () =>
      selectedItems
        .filter(canToggleStockGuard)
        .slice(0, BULK_LISTINGS_MAX)
        .map(item => item.catalogStateId),
    [selectedItems]
  )

  const title = enabled
    ? "Enable Stock Guard for selected listings?"
    : "Disable Stock Guard for selected listings?"
  const description = enabled
    ? "Stock Guard will monitor selected listings and create alerts when source price or availability risk is detected. This only changes monitoring status."
    : "Stock Guard will stop monitoring selected listings. Existing alerts will remain visible. This only changes monitoring status."
  const buttonLabel = enabled ? "Enable Stock Guard" : "Disable Stock Guard"

  async function handleSubmit() {
    if (!confirmChecked || loading || eligibleCount === 0 || overLimit) return
    setLoading(true)
    setError(null)

    const apiResult = await bulkUpdateAppListingStockGuard({
      storeCode,
      catalogStateIds: catalogStateIdsToSend,
      enabled,
      confirm:         true,
    })

    setLoading(false)

    if (!apiResult.ok) {
      if (apiResult.status === 401) {
        router.replace("/app/login")
        return
      }
      if (apiResult.status === 403 && apiResult.approvalStatus === "pending_approval") {
        router.replace("/pending-approval")
        return
      }
      const msg = apiResult.error?.trim()
      setError(
        msg && msg.length <= 120 && !/stack|trace|oauth|token/i.test(msg)
          ? msg
          : "Could not update Stock Guard for selected listings."
      )
      return
    }

    setResult(apiResult.data)
  }

  async function handleCloseAfterSuccess() {
    await onSuccess()
  }

  if (result) {
    const failedItems = result.results.filter(r => !r.ok)
    return (
      <div className="app-modal-overlay" onClick={() => void handleCloseAfterSuccess()} role="presentation">
        <div
          className="app-modal"
          role="dialog"
          aria-labelledby="bulk-guard-result-title"
          onClick={e => e.stopPropagation()}
        >
          <div className="app-modal-header">
            <div>
              <h2 id="bulk-guard-result-title" className="app-modal-title">
                Bulk Stock Guard update complete
              </h2>
              <p className="app-modal-subtitle">
                Selected listings were processed. eBay listings, prices, and quantities were not changed.
              </p>
            </div>
            <button
              type="button"
              className="app-modal-close-x"
              onClick={() => void handleCloseAfterSuccess()}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <ul className="app-modal-summary-list">
            <li>Requested: {result.requested}</li>
            <li>Succeeded: {result.succeeded}</li>
            <li>Failed: {result.failed}</li>
          </ul>

          <p className="app-modal-meta">
            {getBulkResultOutcomeMessage(result.requested, result.succeeded, result.failed)}
          </p>
          {result.batchId && (
            <p className="app-modal-meta" style={{ fontSize: 12 }}>
              {formatBulkBatchRef(result.batchId)}
            </p>
          )}

          {failedItems.length > 0 && failedItems.length <= 5 && (
            <ul className="app-modal-summary-list" style={{ marginTop: 8 }}>
              {failedItems.map(item => (
                <li key={item.catalogStateId}>
                  Listing #{item.catalogStateId}: {item.error ?? "Could not update."}
                </li>
              ))}
            </ul>
          )}

          <div className="app-modal-footer app-modal-footer-actions">
            <button
              type="button"
              className="app-modal-close-btn"
              onClick={() => void handleCloseAfterSuccess()}
            >
              Close
            </button>
            <button type="button" className="app-modal-close-btn" onClick={onViewGuardOn}>
              View Guard On
            </button>
            <button type="button" className="app-modal-primary-btn" onClick={onViewGuardOff}>
              View Guard Off
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="app-modal"
        role="dialog"
        aria-labelledby="bulk-guard-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="bulk-guard-title" className="app-modal-title">
              {title}
            </h2>
            <p className="app-modal-subtitle">{description}</p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <ul className="app-modal-summary-list">
          <li>Selected: {selectedCount}</li>
          <li>Eligible: {eligibleCount}</li>
          <li>Will be skipped: {skippedCount}</li>
          <li>Max allowed per batch: {BULK_LISTINGS_MAX}</li>
        </ul>

        {overLimit && (
          <p className="app-modal-warning">
            Select at most {BULK_LISTINGS_MAX} eligible listings per batch.
          </p>
        )}

        {ineligibleCount > 0 && (
          <p className="app-modal-warning">
            {ineligibleCount} selected listing{ineligibleCount === 1 ? "" : "s"} cannot be updated because{" "}
            {ineligibleCount === 1 ? "it is" : "they are"} ended or invalid.
          </p>
        )}

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-apply-section">
          <h3 className="app-modal-apply-title">Confirm bulk update</h3>
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            I understand this will update Stock Guard monitoring for selected listings.
          </label>
        </div>

        <div className="app-modal-footer app-modal-footer-actions">
          <button type="button" className="app-modal-close-btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className="app-modal-primary-btn"
            disabled={!confirmChecked || eligibleCount === 0 || loading || overLimit}
            onClick={() => void handleSubmit()}
          >
            {loading ? "Updating…" : buttonLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function StockGuardModal({
  item,
  storeCode,
  enabled,
  onClose,
  onSuccess,
}: {
  item: AppListingItem
  storeCode: string
  enabled: boolean
  onClose: () => void
  onSuccess: () => Promise<boolean>
}) {
  const router = useRouter()
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsAsin = !hasAsin(item)
  const title = enabled
    ? "Enable Stock Guard for this listing?"
    : "Disable Stock Guard for this listing?"
  const description = enabled
    ? "Stock Guard will monitor this listing and create alerts when source price or availability risk is detected."
    : "Stock Guard will stop monitoring this listing. Existing alerts will remain visible."
  const checkboxLabel = enabled
    ? "I understand this will enable monitoring for this listing."
    : "I understand this will disable monitoring for this listing."
  const buttonLabel = enabled ? "Enable Stock Guard" : "Disable Stock Guard"

  async function handleSubmit() {
    if (!confirmChecked || loading) return
    setLoading(true)
    setError(null)

    const result = await updateAppListingStockGuard({
      storeCode,
      catalogStateId: item.catalogStateId,
      enabled,
      confirm: true,
    })

    setLoading(false)

    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      if (result.status === 403 && result.approvalStatus === "pending_approval") {
        router.replace("/pending-approval")
        return
      }
      const msg = result.error?.trim()
      setError(
        msg && msg.length <= 120 && !/stack|trace|oauth|token/i.test(msg)
          ? msg
          : "Could not update Stock Guard for this listing."
      )
      return
    }

    await onSuccess()
    onClose()
  }

  return (
    <div className="app-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="app-modal"
        role="dialog"
        aria-labelledby="stock-guard-listing-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="stock-guard-listing-title" className="app-modal-title">
              {title}
            </h2>
            <p className="app-modal-subtitle">{description}</p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="app-modal-meta">
          {dash(item.title)} · {normalizeDisplayAsin(item.asin) ?? "No ASIN"} · #{item.catalogStateId}
        </p>

        {needsAsin && enabled && (
          <p className="app-modal-warn">
            ASIN is missing. Stock Guard may not detect source risks until ASIN is linked.
          </p>
        )}

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-apply-section">
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            {checkboxLabel}
          </label>
        </div>

        <div className="app-modal-footer app-modal-footer-actions">
          <button type="button" className="app-modal-close-btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className="app-modal-primary-btn"
            disabled={!confirmChecked || loading}
            onClick={() => void handleSubmit()}
          >
            {loading ? "Saving…" : buttonLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

const ASIN_INPUT_RE = /^[A-Z0-9]{10}$/

function normalizeAsinInput(raw: string): string {
  return raw.trim().toUpperCase()
}

function UpdateSourceAsinModal({
  item,
  storeCode,
  onClose,
  onSuccess,
}: {
  item: AppListingItem
  storeCode: string
  onClose: () => void
  onSuccess: () => Promise<boolean>
}) {
  const router = useRouter()
  const [newAsin, setNewAsin] = useState("")
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const currentAsin = normalizeDisplayAsin(item.asin)
  const normalizedNew = normalizeAsinInput(newAsin)
  const asinValid = ASIN_INPUT_RE.test(normalizedNew)
  const hasLinkedAsin = Boolean(currentAsin)
  const title = hasLinkedAsin ? "Update source ASIN" : "Link source ASIN"

  useEffect(() => {
    setNewAsin("")
    setConfirmChecked(false)
    setLoading(false)
    setError(null)
    setSuccessMessage(null)
  }, [item.catalogStateId])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !loading) onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, loading])

  async function handleSubmit() {
    if (!confirmChecked || loading || !asinValid) return
    setLoading(true)
    setError(null)

    const result = await updateAppListingSourceAsin({
      storeCode,
      catalogStateId: item.catalogStateId,
      asin: normalizedNew,
      confirm: true,
    })

    setLoading(false)

    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      if (result.status === 403 && result.approvalStatus === "pending_approval") {
        router.replace("/pending-approval")
        return
      }
      const msg = result.error?.trim()
      setError(
        msg && msg.length <= 120 && !/stack|trace|oauth|token|keepa/i.test(msg)
          ? msg
          : "Could not update source ASIN."
      )
      return
    }

    setSuccessMessage(result.data.message)
    await onSuccess()
    onClose()
  }

  if (typeof document === "undefined") return null

  return createPortal(
    <div
      className="app-modal-overlay"
      onClick={loading ? undefined : onClose}
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
      }}
    >
      <div
        className="app-modal"
        role="dialog"
        aria-labelledby="update-source-asin-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="update-source-asin-title" className="app-modal-title">
              {title}
            </h2>
            <p className="app-modal-subtitle">
              Changing the source ASIN affects source price tracking and Stock Guard alerts.
            </p>
          </div>
          <button
            type="button"
            className="app-modal-close-x"
            onClick={onClose}
            disabled={loading}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <PriceField label="Listing title" value={dash(item.title)} wide />
        <PriceField
          label="eBay Item ID"
          value={dash(item.ebayItemId)}
        />
        <PriceField
          label="Current ASIN"
          value={currentAsin ?? "Not linked"}
        />

        <div className="app-modal-field">
          <div className="app-modal-field-label">New ASIN</div>
          <input
            id="new-source-asin"
            type="text"
            value={newAsin}
            disabled={loading}
            onChange={e => setNewAsin(e.target.value)}
            placeholder="B0XXXXXXXX"
            maxLength={10}
            autoComplete="off"
            spellCheck={false}
            style={{
              width: "100%",
              maxWidth: 160,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "inherit",
            }}
          />
          {newAsin.trim() && !asinValid && (
            <span style={{ fontSize: 11, color: "var(--warn)", marginTop: 4, display: "block" }}>
              ASIN must be 10 characters (A–Z, 0–9).
            </span>
          )}
        </div>

        <p className="app-modal-warn">
          This updates source tracking only. It does not change eBay price, quantity, or listing status.
        </p>

        {error && <div className="app-modal-error">{error}</div>}
        {successMessage && <div className="app-modal-success">{successMessage}</div>}

        <div className="app-modal-apply-section">
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            I understand this will update the source ASIN for this listing.
          </label>
        </div>

        <div className="app-modal-footer app-modal-footer-actions">
          <button type="button" className="app-modal-close-btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className="app-modal-primary-btn"
            disabled={!confirmChecked || !asinValid || loading}
            onClick={() => void handleSubmit()}
          >
            {loading ? "Updating…" : "Update Source ASIN"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function EndListingModal({
  item,
  storeCode,
  onClose,
  onSuccess,
}: {
  item: AppListingItem
  storeCode: string
  onClose: () => void
  onSuccess: () => Promise<boolean>
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(false)
    setError(null)
  }, [item.catalogStateId])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !loading) onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, loading])

  async function handleYes() {
    if (loading) return
    setLoading(true)
    setError(null)
    try {
      const result = await endAppListing({
        storeCode,
        catalogStateId: item.catalogStateId,
        confirm: true,
      })

      if (!result.ok) {
        if (result.status === 401) {
          router.replace("/app/login")
          return
        }
        if (result.status === 403 && result.approvalStatus === "pending_approval") {
          router.replace("/pending-approval")
          return
        }
        const msg = result.error?.trim()
        setError(
          msg && msg.length <= 120 && !/stack|trace|oauth|token|ebay/i.test(msg)
            ? msg
            : "Could not remove listing."
        )
        return
      }

      onClose()
      void onSuccess().catch(() => undefined)
    } catch {
      setError("The result is unknown. Verify eBay and Listings before retrying.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app-modal-overlay" onClick={loading ? undefined : onClose} role="presentation">
      <div
        className="app-modal"
        role="dialog"
        aria-labelledby="end-listing-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="end-listing-title" className="app-modal-title">
              Remove selected listings?
            </h2>
            <p className="app-modal-subtitle">
              1 listing will be ended on eBay and permanently removed from ListJetGo. Are you sure?
            </p>
          </div>
          <button
            type="button"
            className="app-modal-close-x"
            onClick={onClose}
            disabled={loading}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <p className="app-modal-meta">
          {dash(item.title)} · {normalizeDisplayAsin(item.asin) ?? "No ASIN"} · #{item.catalogStateId}
        </p>

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-footer app-modal-footer-actions">
          <button type="button" className="app-modal-close-btn" onClick={onClose} disabled={loading}>
            No
          </button>
          <button
            type="button"
            className="app-modal-primary-btn app-modal-danger-btn"
            disabled={loading}
            onClick={() => void handleYes()}
          >
            {loading ? "Removing…" : "Yes"}
          </button>
        </div>
      </div>
    </div>
  )
}

function RecommendedPriceModal({
  item,
  storeCode,
  loading,
  error,
  data,
  onClose,
  onUpdateSuccess,
}: {
  item: AppListingItem
  storeCode: string
  loading: boolean
  error: string | null
  data: AppRecommendedPriceResponse | null
  onClose: () => void
  onUpdateSuccess: () => Promise<boolean>
}) {
  const router = useRouter()
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [belowRecommendedChecked, setBelowRecommendedChecked] = useState(false)
  const [customPrice, setCustomPrice] = useState("")
  const [updateLoading, setUpdateLoading] = useState(false)
  const [updateError, setUpdateError] = useState<{ text: string; info: boolean } | null>(null)
  const [updateSuccess, setUpdateSuccess] = useState<AppUpdateListingPriceResponse | null>(null)
  const [refetchWarning, setRefetchWarning] = useState<string | null>(null)

  useEffect(() => {
    setConfirmChecked(false)
    setBelowRecommendedChecked(false)
    setCustomPrice(data && Number.isFinite(data.recommendedEbayPrice) && data.recommendedEbayPrice > 0
      ? data.recommendedEbayPrice.toFixed(2)
      : "")
    setUpdateLoading(false)
    setUpdateError(null)
    setUpdateSuccess(null)
    setRefetchWarning(null)
  }, [item.catalogStateId, data?.catalogStateId])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !updateLoading) onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, updateLoading])

  const safetyMessage = applySafetyMessage(data)
  const finalPrice = parseEditableUsdPrice(customPrice)
  const isBelowRecommended = data != null && finalPrice != null && finalPrice < data.recommendedEbayPrice
  const canApply = data != null && finalPrice != null && confirmChecked &&
    (!isBelowRecommended || belowRecommendedChecked) && !updateLoading && !updateSuccess

  async function handleApplyPrice() {
    if (!data || !storeCode || finalPrice == null || !confirmChecked ||
      (isBelowRecommended && !belowRecommendedChecked) || updateSuccess || updateLoading) return

    setUpdateLoading(true)
    setUpdateError(null)
    setRefetchWarning(null)

    const result = await updateAppListingPrice({
      storeCode,
      catalogStateId: item.catalogStateId,
      price: finalPrice,
      confirm: true,
    })

    setUpdateLoading(false)

    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      if (result.status === 403 && result.approvalStatus === "pending_approval") {
        router.replace("/pending-approval")
        return
      }
      setUpdateError(mapPriceUpdateError(result.error, result.status))
      return
    }

    setUpdateSuccess(result.data)
    const refetchOk = await onUpdateSuccess()
    if (!refetchOk) {
      setRefetchWarning("List refresh failed. Price was updated successfully.")
    }
  }

  return (
    <div className="app-modal-overlay" role="presentation" onClick={updateLoading ? undefined : onClose}>
      <div
        className="app-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recommended-price-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="recommended-price-title" className="app-modal-title">
              Recommended Price
            </h2>
            <p className="app-modal-subtitle">{dash(item.title)}</p>
            <p className="app-modal-meta">
              eBay ID: {dash(item.ebayItemId)} · ASIN: {dash(item.asin)}
            </p>
          </div>
          <button
            type="button"
            className="app-modal-close-x"
            onClick={onClose}
            disabled={updateLoading}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {loading && (
          <p className="app-modal-loading">Loading price suggestion…</p>
        )}

        {error && !loading && (
          <p className="app-modal-error">{error}</p>
        )}

        {updateSuccess && (
          <>
            <div className="app-modal-success">
              <div className="app-modal-success-title">Price updated successfully.</div>
              <p className="app-modal-success-desc">
                Your eBay listing price was updated. Related price-increase alerts may now be marked
                as actioned after refresh.
              </p>
            </div>
            <div className="app-modal-grid">
              <PriceField label="Old eBay price" value={fmtPrice(updateSuccess.oldEbayPrice)} />
              <PriceField label="New eBay price" value={fmtPrice(updateSuccess.newEbayPrice)} highlight />
              <PriceField label="eBay Item ID" value={dash(updateSuccess.ebayItemId)} wide />
            </div>
            <p className="app-modal-warn">Stock Alerts will refresh when opened.</p>
            {refetchWarning && <p className="app-modal-warn">{refetchWarning}</p>}
          </>
        )}

        {data && !loading && !updateSuccess && (
          <>
            <div className="app-modal-grid">
              <PriceField label="Source / Amazon price" value={fmtPrice(data.amazonPrice)} />
              <PriceField
                label="Current eBay price"
                value={fmtPrice(data.currentEbayPrice)}
              />
              <PriceField label="Store markup" value={`${data.storeMarkupPercent}%`} />
              <PriceField
                label="Recommended eBay price"
                value={fmtPrice(data.recommendedEbayPrice)}
                highlight
              />
              <PriceField label="Pricing source" value={formatPricingSource(data.pricingSource)} wide />
              {data.promotionAdRatePercent != null && data.promotionAdRatePercent > 0 && (
                <>
                  <PriceField label="Reklam" value={`%${data.promotionAdRatePercent}`} />
                  <PriceField
                    label="Reklam gideri etkisi"
                    value={
                      data.promotionFeeImpactPercent != null
                        ? `%${data.promotionFeeImpactPercent}`
                        : "—"
                    }
                  />
                  <PriceField
                    label="Reklamsız önerilen fiyat"
                    value={fmtPrice(data.unpromotedRecommendedEbayPrice ?? data.recommendedEbayPrice)}
                  />
                  <PriceField
                    label="Reklamlı önerilen fiyat"
                    value={fmtPrice(data.promotedRecommendedEbayPrice ?? data.recommendedEbayPrice)}
                    highlight
                  />
                </>
              )}
            </div>

            {safetyMessage && <p className="app-modal-note">{safetyMessage}</p>}

            <div className="app-modal-apply-section">
              <h3 className="app-modal-apply-title">Apply listing price</h3>
              <p className="app-modal-apply-desc">
                Choose the final USD price to send to eBay. The recommended price is prefilled for you.
              </p>
              <label className="app-modal-apply-label" htmlFor="listing-custom-price">
                Custom price (USD)
              </label>
              <input
                id="listing-custom-price"
                className="app-modal-apply-input"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={customPrice}
                onChange={e => {
                  setCustomPrice(e.target.value)
                  setBelowRecommendedChecked(false)
                  setUpdateError(null)
                }}
                disabled={updateLoading}
                aria-describedby="listing-final-price"
              />
              <p id="listing-final-price" className="app-modal-apply-desc">
                Final price to send to eBay: {finalPrice == null ? "Enter a positive USD amount with up to 2 decimals." : fmtPrice(finalPrice)}
              </p>
              {isBelowRecommended && (
                <>
                  <p className="app-modal-warning">
                    This price is below the recommended price of {fmtPrice(data.recommendedEbayPrice)}.
                  </p>
                  <label className="app-modal-apply-checkbox">
                    <input
                      type="checkbox"
                      checked={belowRecommendedChecked}
                      onChange={e => setBelowRecommendedChecked(e.target.checked)}
                      disabled={updateLoading}
                    />
                    <span>I confirm that I want to apply a price below the recommendation.</span>
                  </label>
                </>
              )}
              <label className="app-modal-apply-checkbox">
                <input
                  type="checkbox"
                  checked={confirmChecked}
                  onChange={e => setConfirmChecked(e.target.checked)}
                  disabled={updateLoading}
                />
                <span>I understand this will update my eBay listing price.</span>
              </label>
              {updateError && (
                <p className={updateError.info ? "app-modal-info" : "app-modal-error"}>{updateError.text}</p>
              )}
              <button
                type="button"
                className="app-modal-primary-btn"
                disabled={!canApply}
                onClick={() => void handleApplyPrice()}
              >
                {updateLoading ? "Applying…" : "Apply price"}
              </button>
            </div>
          </>
        )}

        <div className={updateSuccess ? "app-modal-footer-actions" : "app-modal-footer"}>
          <button type="button" className="app-modal-close-btn" onClick={onClose} disabled={updateLoading}>
            Close
          </button>
          {updateSuccess && (
            <>
              <button type="button" className="app-modal-close-btn" onClick={onClose}>
                View Listing List
              </button>
              <Link
                href={stockAlertsHref(storeCode)}
                className="app-modal-primary-btn app-modal-link-btn"
                onClick={onClose}
              >
                View Stock Alerts
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function PriceField({
  label,
  value,
  highlight = false,
  wide = false,
}: {
  label: string
  value: string
  highlight?: boolean
  wide?: boolean
}) {
  return (
    <div className={`app-modal-field${wide ? " app-modal-field--wide" : ""}${highlight ? " app-modal-field--highlight" : ""}`}>
      <div className="app-modal-field-label">{label}</div>
      <div className="app-modal-field-value">{value}</div>
    </div>
  )
}

function StatusBadge({
  label,
  variant,
}: {
  label: string
  variant: "ok" | "warn" | "dim" | "info" | "critical"
}) {
  return <span className={`lj-badge lj-badge--${variant}`}>{label}</span>
}

const thStyle: CSSProperties = {
  padding: "7px 7px",
  fontWeight: 600,
  whiteSpace: "nowrap",
  fontSize: 11,
}

const sortButtonStyle: CSSProperties = {
  border: 0,
  padding: 0,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
  textAlign: "left",
}

const checkboxThStyle: CSSProperties = {
  ...thStyle,
  width: 40,
  padding: "10px 8px",
}

const checkboxTdStyle: CSSProperties = {
  padding: "10px 8px",
  borderTop: "1px solid var(--border)",
  verticalAlign: "middle",
}

const tdStyle: CSSProperties = {
  padding: "6px 7px",
  borderTop: "1px solid var(--border)",
  verticalAlign: "middle",
  fontSize: 11,
  whiteSpace: "nowrap",
}

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
  fontSize: 11,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
}

const selectStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "inherit",
  fontSize: 13,
}

const ghostBtnStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 13,
}

const ghostLinkStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  color: "inherit",
  textDecoration: "none",
  fontSize: 13,
}

const primaryLinkStyle: CSSProperties = {
  display: "inline-block",
  padding: "8px 16px",
  borderRadius: 6,
  background: "var(--accent, #3b82f6)",
  color: "#fff",
  fontWeight: 600,
  textDecoration: "none",
  fontSize: 13,
}

const summaryCtaStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "8px 14px",
  borderRadius: 6,
  border: "none",
  background: "var(--accent, #3b82f6)",
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
  textDecoration: "none",
}

const linkAsinBtnStyle: CSSProperties = {
  display: "inline-block",
  padding: "4px 8px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  fontSize: 11,
  color: "inherit",
  textDecoration: "none",
  whiteSpace: "nowrap",
}

const actionBtnStyle: CSSProperties = {
  padding: "4px 8px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  fontSize: 11,
  whiteSpace: "nowrap",
}

const externalLinkStyle: CSSProperties = {
  color: "var(--accent, #3b82f6)",
  textDecoration: "none",
}

const externalLinkBtnStyle: CSSProperties = {
  display: "inline-block",
  padding: "4px 8px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  fontSize: 11,
  color: "var(--accent, #3b82f6)",
  textDecoration: "none",
  whiteSpace: "nowrap",
}

const syncStatusRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 16,
  lineHeight: 1.5,
}

const pageBtnStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
}

const errorBoxStyle: CSSProperties = {
  padding: 16,
  marginBottom: 16,
  borderRadius: 8,
  border: "1px solid #c44",
  background: "rgba(200,60,60,0.08)",
  color: "#e88",
}

const emptyBoxStyle: CSSProperties = {
  padding: 24,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--dim)",
}

function ListingPromotionModal({
  item,
  storeCode,
  storeId,
  marketingGranted,
  onClose,
  onSuccess,
}: {
  item: AppListingItem
  storeCode: string
  storeId?: number
  marketingGranted: boolean
  onClose: () => void
  onSuccess: () => Promise<void>
}) {
  const current = item.promotion
  const [enabled, setEnabled] = useState(true)
  const [rate, setRate] = useState(String(current?.effectiveRate ?? current?.requestedRate ?? 5))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(current?.status === "FAILED" ? (current.message || null) : null)
  const [errorCode, setErrorCode] = useState<string | null>(current?.status === "FAILED" ? (current.code || null) : null)

  async function finish(promotion: AppListingItem["promotion"] | undefined, expectOff: boolean) {
    if (!promotion) {
      setError("Reklam bağlantısı tamamlanamadı")
      return
    }
    if (promotion.status === "ACTIVE" || (expectOff && promotion.status === "OFF")) {
      await onSuccess()
      return
    }
    setError(promotion.message || "Reklam bağlantısı tamamlanamadı")
    setErrorCode(promotion.code)
  }

  async function save() {
    if (!marketingGranted || busy) return
    setBusy(true)
    setError(null)
    setErrorCode(null)
    try {
      const n = Number(rate)
      const saved = await applyAppListingPromotion({
        storeCode,
        storeId,
        catalogStateId: item.catalogStateId,
        promotedEnabled: enabled,
        promotedAdRate: enabled ? n : undefined,
      })
      if (!saved.ok) throw new Error(saved.error || "Reklam kaydedilemedi")
      await finish(saved.data.promotion, !enabled)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reklam kaydedilemedi")
    } finally {
      setBusy(false)
    }
  }

  async function retry() {
    if (!marketingGranted || busy) return
    setBusy(true)
    setError(null)
    setErrorCode(null)
    try {
      const result = await retryAppListingPromotion({ storeCode, storeId, catalogStateId: item.catalogStateId })
      if (!result.ok) throw new Error(result.error || "Tekrar deneme başarısız")
      await finish(result.data.promotion, false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tekrar deneme başarısız")
    } finally {
      setBusy(false)
    }
  }

  async function verify() {
    if (!marketingGranted || busy) return
    setBusy(true)
    setError(null)
    setErrorCode(null)
    try {
      const result = await verifyAppListingPromotion({ storeCode, storeId, catalogStateId: item.catalogStateId })
      if (!result.ok) throw new Error(result.error || "Doğrulama başarısız")
      await finish(result.data.promotion, false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Doğrulama başarısız")
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="app-modal-overlay" onClick={busy ? undefined : onClose} role="presentation">
      <div className="app-modal app-promo-modal" role="dialog" aria-labelledby="listing-promotion-title" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <h2 id="listing-promotion-title" className="app-modal-title">Reklam</h2>
        {!marketingGranted && (
          <p className="app-promo-modal-note">
            eBay bağlantısını yenileyin.{" "}
            <Link href="/app/settings" style={{ color: "inherit", fontWeight: 700 }}>
              Mağaza ayarları
            </Link>
          </p>
        )}
        <label className="app-promo-modal-label">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          Reklamı aç
        </label>
        <label className="app-promo-modal-label app-promo-modal-label--block">
          Oran
          <span className="app-promo-rate-wrap">
            <input
              className="app-promo-rate-input"
              type="number"
              min={2}
              max={100}
              step={0.1}
              placeholder="5"
              value={rate}
              onChange={e => setRate(e.target.value)}
              disabled={!enabled}
            />
            <span className="app-promo-rate-suffix">%</span>
          </span>
        </label>
        <p className="app-promo-modal-status">
          {current?.status === "ACTIVE" && (current.effectiveRate ?? current.requestedRate) != null
            ? `%${current.effectiveRate ?? current.requestedRate} aktif`
            : (current?.message || "Reklam durumu bilinmiyor")}
        </p>
        {error && (
          <div className="app-promo-error" role="alert">
            <div>{error}</div>
            {errorCode && <div className="app-promo-error-code">{errorCode}</div>}
          </div>
        )}
        <div className="app-promo-modal-actions">
          <button type="button" className="app-bulk-toolbar-btn app-bulk-toolbar-btn--primary" disabled={busy || !marketingGranted} onClick={() => void save()}>
            {busy ? "Kaydediliyor…" : "Kaydet"}
          </button>
          <button type="button" className="app-bulk-toolbar-btn" disabled={busy || !marketingGranted} onClick={() => void retry()}>
            Tekrar dene
          </button>
          <button type="button" className="app-bulk-toolbar-btn" disabled={busy || !marketingGranted} onClick={() => void verify()}>
            eBay’den doğrula
          </button>
          <button type="button" className="app-bulk-toolbar-btn" onClick={onClose}>Kapat</button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function BulkListingPromotionModal({
  storeCode,
  storeId,
  selectedItems,
  onClose,
  onSuccess,
}: {
  storeCode: string
  storeId?: number
  selectedItems: AppListingItem[]
  onClose: () => void
  onSuccess: () => Promise<void>
}) {
  const [rate, setRate] = useState("5")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)

  async function apply() {
    setBusy(true)
    setError(null)
    try {
      const n = Number(rate)
      const ids = selectedItems.map(i => i.catalogStateId)
      const result = await bulkApplyAppListingPromotion({
        storeCode,
        storeId,
        catalogStateIds: ids,
        promotedEnabled: true,
        promotedAdRate: n,
      })
      if (!result.ok) throw new Error(result.error || "Toplu reklam uygulanamadı")
      setSummary(`${result.data.succeeded}/${result.data.requested} başarılı`)
      if (result.data.failed === 0) await onSuccess()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toplu reklam uygulanamadı")
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="app-modal-overlay" onClick={busy ? undefined : onClose} role="presentation">
      <div className="app-modal" role="dialog" aria-labelledby="bulk-promotion-title" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <h2 id="bulk-promotion-title" className="app-modal-title">Seçilenlere reklam uygula</h2>
        <p style={{ fontSize: 13 }}>{selectedItems.length} listing için ortak oran</p>
        <label style={{ display: "block", marginTop: 10, fontSize: 12 }}>
          Oran
          <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            <input type="number" min={2} max={100} step={0.5} value={rate} onChange={e => setRate(e.target.value)} style={{ width: 90, padding: 6 }} />
            %
          </span>
        </label>
        {summary && <p style={{ fontSize: 12 }}>{summary}</p>}
        {error && <p style={{ color: "#e88", fontSize: 12 }}>{error}</p>}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button type="button" className="app-bulk-toolbar-btn app-bulk-toolbar-btn--primary" disabled={busy} onClick={() => void apply()}>
            {busy ? "Uygulanıyor…" : "Uygula"}
          </button>
          <button type="button" className="app-bulk-toolbar-btn" onClick={onClose}>Kapat</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
