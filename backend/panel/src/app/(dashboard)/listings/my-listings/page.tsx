"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import {
  getMonitorListings,
  getStores,
  postMonitorBlind,
  postMonitorUpdateStock,
  postListingsStockGuard,
  postListingsRemoveFromList,
  postListingsEnd,
  postListingsSyncListings,
  postListingsSyncMetrics,
} from "@/lib/api"
import type { MonitorItem, StoreRow, MonitorResult, EndListingItemRef } from "@/lib/api"
import { useStore } from "@/lib/storeContext"
import { useToast } from "@/lib/toastContext"
import { ConfirmModal } from "@/components/ConfirmModal"
import {
  UpdateSourceAsinModal,
  type UpdateSourceAsinTarget,
} from "@/components/listings/UpdateSourceAsinModal"
import {
  UpdateEbayPriceModal,
  type UpdateEbayPriceTarget,
} from "@/components/listings/UpdateEbayPriceModal"
import { AnchoredDropdownMenu } from "@/components/ui/AnchoredDropdownMenu"
import { isUiTurkish } from "@/lib/sourceStatusDisplay"
import {
  type StatusFilter,
  type SortColumn,
  type SortDir,
  toSortNumber,
  deriveSourceStatus,
  getAmazonUrl,
  getEbayUrl,
  formatPrice,
  ebayPriceTooltip,
  formatAmazonPrice,
  formatSourceCheckedAgo,
  formatDate,
  formatClicksCell,
  formatSoldCount,
  formatRelativeTime,
  SOURCE_BADGE_COLORS,
} from "@/lib/listingsUtils"

type BulkAction =
  | ""
  | "set_qty_0"
  | "set_qty_1"
  | "end_listing"
  | "remove_from_list"
  | "guard_on"
  | "guard_off"

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "qty0", label: "Qty 0" },
  { key: "bot_zeroed", label: "Bot Zeroed" },
  { key: "amazon_unavailable", label: "Amazon Unavailable" },
  { key: "no_price", label: "No Price" },
  { key: "check_failed", label: "Check Failed" },
  { key: "no_asin", label: "No ASIN" },
  { key: "guard_on", label: "Guard On" },
  { key: "guard_off", label: "Guard Off" },
]

const BULK_ACTIONS: { key: BulkAction; label: string; connected: boolean }[] = [
  { key: "set_qty_0", label: "Set Qty 0", connected: true },
  { key: "set_qty_1", label: "Set Qty 1", connected: true },
  { key: "end_listing", label: "End Listing", connected: true },
  { key: "remove_from_list", label: "Remove from List", connected: true },
  { key: "guard_on", label: "Add to Stock Guard", connected: true },
  { key: "guard_off", label: "Remove from Stock Guard", connected: true },
]

const SORT_LABELS: Record<SortColumn, string> = {
  title: "Title",
  asin: "ASIN",
  ebay_item_id: "eBay ID",
  quantity: "Qty",
  price: "eBay Price",
  amazon_price: "Amazon Price",
  source_status: "Source Status",
  upload_date: "Upload Date",
  total_sold: "Sold",
  clicks_30d: "30D Clicks",
}

const PAGE_SIZE = 50

/** Backend sortBy keys */
const NUMERIC_SORTS = new Set([
  "quantity",
  "ebayPrice",
  "sourcePrice",
  "totalSold",
  "clicks30d",
])

const DATE_SORTS = new Set(["listedAt"])

const API_TO_COLUMN: Record<string, SortColumn> = {
  title: "title",
  asin: "asin",
  ebayItemId: "ebay_item_id",
  quantity: "quantity",
  ebayPrice: "price",
  sourcePrice: "amazon_price",
  sourceStatus: "source_status",
  listedAt: "upload_date",
  totalSold: "total_sold",
  clicks30d: "clicks_30d",
}

function getDefaultSortDir(sortKey: string): SortDir {
  if (NUMERIC_SORTS.has(sortKey)) return "desc"
  if (DATE_SORTS.has(sortKey)) return "desc"
  return "asc"
}

function getNextSort(
  sortBy: string | null,
  sortDir: SortDir,
  clickedSortBy: string
): { sortBy: string; sortDir: SortDir } {
  if (sortBy !== clickedSortBy) {
    return { sortBy: clickedSortBy, sortDir: getDefaultSortDir(clickedSortBy) }
  }
  return { sortBy: clickedSortBy, sortDir: sortDir === "desc" ? "asc" : "desc" }
}

const mono: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "11px",
}

const thStyle: React.CSSProperties = {
  ...mono,
  padding: "8px 10px",
  textAlign: "left",
  fontWeight: 700,
  color: "var(--dim)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  whiteSpace: "nowrap",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
  position: "sticky",
  top: 0,
  zIndex: 2,
  cursor: "pointer",
  userSelect: "none",
}

const tdStyle: React.CSSProperties = {
  ...mono,
  padding: "8px 10px",
  color: "var(--text)",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "middle",
}

function Spinner({ size = "sm" }: { size?: "sm" | "md" }) {
  const dim = size === "sm" ? "h-4 w-4 border-2" : "h-9 w-9 border-2"
  return (
    <span
      className={`inline-block shrink-0 rounded-full border-[var(--border)] border-t-[var(--accent)] animate-spin ${dim}`}
      role="status"
      aria-label="Loading"
    />
  )
}

type SelectedListingMeta = { ebayItemId: string; catalogStateId: number | null }

function stockGuardRefsFromSelection(
  selectedBySku: Map<string, SelectedListingMeta>
): { ebayItemId?: string; catalogStateId?: number }[] {
  const out: { ebayItemId?: string; catalogStateId?: number }[] = []
  const seenEbay = new Set<string>()
  const seenCatalog = new Set<number>()
  for (const meta of selectedBySku.values()) {
    const ebayId = meta.ebayItemId.trim()
    if (ebayId) {
      if (!seenEbay.has(ebayId)) {
        seenEbay.add(ebayId)
        out.push({ ebayItemId: ebayId })
      }
      continue
    }
    if (meta.catalogStateId != null && meta.catalogStateId > 0 && !seenCatalog.has(meta.catalogStateId)) {
      seenCatalog.add(meta.catalogStateId)
      out.push({ catalogStateId: meta.catalogStateId })
    }
  }
  return out
}

function endItemsFromSelection(selectedBySku: Map<string, SelectedListingMeta>): EndListingItemRef[] {
  return stockGuardRefsFromSelection(selectedBySku) as EndListingItemRef[]
}

function ebayItemsFromSelectedMap(
  selectedBySku: Map<string, SelectedListingMeta>
): { ebayItemId: string }[] {
  const out: { ebayItemId: string }[] = []
  const seen = new Set<string>()
  for (const { ebayItemId } of selectedBySku.values()) {
    const id = ebayItemId.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ ebayItemId: id })
  }
  return out
}

function ToolbarMoreMenu({
  onUpdateSalesData,
  onSyncListings,
  salesBusy,
  listingsBusy,
  disabled,
}: {
  onUpdateSalesData: () => void
  onSyncListings: () => void
  salesBusy: boolean
  listingsBusy: boolean
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!open) return
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  const menuBtn: React.CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "8px 12px",
    border: "none",
    background: "transparent",
    color: "var(--text)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: "11px",
    cursor: "pointer",
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        aria-label="More actions"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        style={{
          ...mono,
          padding: "7px 12px",
          border: "1px solid var(--border)",
          borderRadius: "3px",
          background: "var(--bg)",
          color: "var(--sub)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            marginTop: 4,
            minWidth: 220,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            zIndex: 50,
            overflow: "hidden",
          }}
        >
          <button
            type="button"
            style={menuBtn}
            disabled={salesBusy || listingsBusy}
            onClick={() => {
              onUpdateSalesData()
              setOpen(false)
            }}
          >
            {salesBusy ? "Updating sales data…" : "Update sales data"}
          </button>
          <button
            type="button"
            style={{ ...menuBtn, color: "var(--dim)", fontSize: 10 }}
            disabled={salesBusy || listingsBusy}
            onClick={() => {
              onSyncListings()
              setOpen(false)
            }}
          >
            {listingsBusy ? "Syncing listings…" : "Sync listings from eBay"}
          </button>
        </div>
      )}
    </div>
  )
}

function RowActionMenu({
  item,
  onSetQty0,
  onSetQty1,
  onEndListing,
  onRemoveFromList,
  onStockGuard,
  onStopTracking,
  onUpdateSourceAsin,
  onUpdateEbayPrice,
  busy,
}: {
  item: MonitorItem
  onSetQty0: (item: MonitorItem) => void
  onSetQty1: (item: MonitorItem) => void
  onEndListing: (item: MonitorItem) => void
  onRemoveFromList: (item: MonitorItem) => void
  onStockGuard: (item: MonitorItem, enabled: boolean) => void
  onStopTracking: (item: MonitorItem) => void
  onUpdateSourceAsin: (item: MonitorItem) => void
  onUpdateEbayPrice: (item: MonitorItem) => void
  busy: boolean
}) {
  const tr = isUiTurkish()

  const amazonUrl = getAmazonUrl(item)
  const ebayUrl = getEbayUrl(item)

  const guardEnabled = item.stockGuardEnabled !== false

  const menuBtn: React.CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "8px 12px",
    border: "none",
    background: "transparent",
    color: "var(--text)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: "11px",
    cursor: "pointer",
  }

  return (
    <AnchoredDropdownMenu
      ariaLabel="Row actions"
      minWidth={180}
      buttonChildren="⋮"
      buttonStyle={{
        ...mono,
        padding: "4px 8px",
        border: "1px solid var(--border)",
        borderRadius: "3px",
        background: "var(--bg)",
        color: "var(--sub)",
        cursor: "pointer",
      }}
    >
      {(close) => (
        <>
          <button
            type="button"
            style={menuBtn}
            disabled={!amazonUrl}
            onClick={() => {
              if (amazonUrl) window.open(amazonUrl, "_blank", "noopener,noreferrer")
              close()
            }}
          >
            Open Amazon
          </button>
          <button
            type="button"
            style={menuBtn}
            disabled={!ebayUrl}
            onClick={() => {
              if (ebayUrl) window.open(ebayUrl, "_blank", "noopener,noreferrer")
              close()
            }}
          >
            Open eBay
          </button>
          <button
            type="button"
            style={{ ...menuBtn, color: "var(--warn)" }}
            disabled={busy || !item.sku?.trim()}
            onClick={() => {
              void onSetQty0(item)
              close()
            }}
          >
            Set Qty 0
          </button>
          <button
            type="button"
            style={menuBtn}
            disabled={busy || !item.sku?.trim()}
            onClick={() => {
              void onSetQty1(item)
              close()
            }}
          >
            Set Qty 1
          </button>
          <button
            type="button"
            style={{ ...menuBtn, color: "var(--danger)" }}
            disabled={busy || (!item.ebayItemId?.trim() && item.catalogStateId == null)}
            onClick={() => {
              onEndListing(item)
              close()
            }}
          >
            End Listing
          </button>
          <button
            type="button"
            style={menuBtn}
            disabled={busy || !item.ebayItemId?.trim()}
            onClick={() => {
              onRemoveFromList(item)
              close()
            }}
          >
            Remove from List
          </button>
          <button
            type="button"
            style={menuBtn}
            disabled={busy || (!item.ebayItemId?.trim() && item.catalogStateId == null)}
            onClick={() => {
              void onStopTracking(item)
              close()
            }}
          >
            {tr ? "Takibi Bırak" : "Stop Tracking"}
          </button>
          <button
            type="button"
            style={menuBtn}
            disabled={busy || !item.ebayItemId?.trim()}
            onClick={() => {
              onStockGuard(item, !guardEnabled)
              close()
            }}
          >
            {guardEnabled ? "Remove from Stock Guard" : "Add to Stock Guard"}
          </button>
          <button
            type="button"
            style={menuBtn}
            disabled={busy || item.catalogStateId == null}
            onClick={() => {
              onUpdateSourceAsin(item)
              close()
            }}
          >
            {tr ? "Kaynak ASIN Güncelle" : "Update Source ASIN"}
          </button>
          <button
            type="button"
            style={menuBtn}
            disabled={busy || item.catalogStateId == null}
            onClick={() => {
              onUpdateEbayPrice(item)
              close()
            }}
          >
            {tr ? "eBay Fiyatını Güncelle" : "Update eBay Price"}
          </button>
        </>
      )}
    </AnchoredDropdownMenu>
  )
}

export default function MyListingsPage() {
  const { selectedStore, setSelectedStore, isStoreReady } = useStore()
  const { showToast } = useToast()

  const [stores, setStores] = useState<StoreRow[]>([])
  const [items, setItems] = useState<MonitorItem[]>([])
  const [totalPages, setTotalPages] = useState(1)
  const [filteredTotal, setFilteredTotal] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [selectedBySku, setSelectedBySku] = useState<Map<string, SelectedListingMeta>>(
    () => new Map()
  )
  const selectAllRef = useRef<HTMLInputElement>(null)
  const [bulkAction, setBulkAction] = useState<BulkAction>("")
  const [bulkBusy, setBulkBusy] = useState(false)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)
  const [pendingRemoveSkus, setPendingRemoveSkus] = useState<Set<string> | null>(null)
  const [endConfirmOpen, setEndConfirmOpen] = useState(false)
  const [pendingEndItems, setPendingEndItems] = useState<EndListingItemRef[] | null>(null)
  const [metricsConfirmOpen, setMetricsConfirmOpen] = useState(false)
  const [metricsBusy, setMetricsBusy] = useState(false)
  const [listingsSyncConfirmOpen, setListingsSyncConfirmOpen] = useState(false)
  const [listingsSyncBusy, setListingsSyncBusy] = useState(false)
  const [storeSyncInfo, setStoreSyncInfo] = useState<MonitorResult["storeSync"]>(undefined)
  const [sortBy, setSortBy] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const sortByRef = useRef<string | null>(null)
  const sortDirRef = useRef<SortDir>("desc")
  const loadSeqRef = useRef(0)
  const skipSortFetchEffectRef = useRef(false)
  const selectedStoreRef = useRef(selectedStore)
  const fetchAbortRef = useRef<AbortController | null>(null)
  const [sourceAsinModalOpen, setSourceAsinModalOpen] = useState(false)
  const [sourceAsinTarget, setSourceAsinTarget] = useState<UpdateSourceAsinTarget | null>(null)
  const [ebayPriceModalOpen, setEbayPriceModalOpen] = useState(false)
  const [ebayPriceTarget, setEbayPriceTarget] = useState<UpdateEbayPriceTarget | null>(null)

  useEffect(() => {
    selectedStoreRef.current = selectedStore
  }, [selectedStore])

  useEffect(() => {
    if (!selectedStore) return
    loadSeqRef.current++
    fetchAbortRef.current?.abort()
    fetchAbortRef.current = null
    setItems([])
    setLoading(true)
    setSelectedBySku(new Map())
  }, [selectedStore])

  useEffect(() => {
    void getStores()
      .then(d => setStores(d.rows ?? []))
      .catch(() => setStores([]))
  }, [])

  useEffect(() => {
    const active = stores.filter(s => s.status === "active")
    const list = active.length > 0 ? active : stores
    if (list.length === 0) return
    if (!list.some(s => s.storeCode === selectedStore)) {
      setSelectedStore(list[0].storeCode)
    }
  }, [stores, selectedStore, setSelectedStore])

  useEffect(() => {
    setCurrentPage(1)
    setSelectedBySku(new Map())
  }, [selectedStore, search, statusFilter])

  function clearSelection() {
    setSelectedBySku(new Map())
  }

  const fetchListings = useCallback(
    async (params: { page: number; sortBy: string | null; sortDir: SortDir }) => {
      if (!isStoreReady || !selectedStore) {
        setLoading(false)
        return
      }
      const requestStore = selectedStore
      fetchAbortRef.current?.abort()
      const abortController = new AbortController()
      fetchAbortRef.current = abortController

      setLoading(true)
      const seq = ++loadSeqRef.current
      try {
        const res = await getMonitorListings(
          requestStore,
          {
            offset: (params.page - 1) * PAGE_SIZE,
            limit: PAGE_SIZE,
            search: search.trim() || undefined,
            status: statusFilter,
            sortBy: params.sortBy ?? undefined,
            sortDir: params.sortBy ? params.sortDir : undefined,
          },
          abortController.signal
        )
        if (abortController.signal.aborted) return
        if (seq !== loadSeqRef.current) return
        if (requestStore !== selectedStoreRef.current) return

        const normalized = res.items.map(item => ({
          ...item,
          views30d: toSortNumber(item.views30d),
          watchCount: toSortNumber(item.watchCount),
        }))

        // Sort is applied server-side on the full filtered set before pagination.
        setItems(normalized)
        setTotalPages(Math.max(1, res.totalPages))
        setFilteredTotal(res.total)
        setStoreSyncInfo(res.storeSync ?? undefined)
      } catch (e) {
        if (abortController.signal.aborted) return
        if (seq !== loadSeqRef.current) return
        if (requestStore !== selectedStoreRef.current) return
        setItems([])
        setTotalPages(1)
        setFilteredTotal(0)
        showToast(e instanceof Error ? e.message : "Failed to load listings", "error")
      } finally {
        if (seq === loadSeqRef.current && requestStore === selectedStoreRef.current) {
          setLoading(false)
        }
      }
    },
    [selectedStore, search, statusFilter, showToast, isStoreReady]
  )

  useEffect(() => {
    if (!isStoreReady || !selectedStore) return
    if (skipSortFetchEffectRef.current) {
      skipSortFetchEffectRef.current = false
      return
    }
    void fetchListings({
      page: currentPage,
      sortBy: sortByRef.current,
      sortDir: sortDirRef.current,
    })
  }, [fetchListings, isStoreReady, selectedStore, currentPage, search, statusFilter])

  const storeOptions = useMemo(() => {
    const active = stores.filter(s => s.status === "active")
    return active.length > 0 ? active : stores
  }, [stores])

  const selectedCount = selectedBySku.size

  const currentPageSelectedCount = useMemo(
    () => items.filter(i => i.sku && selectedBySku.has(i.sku.trim())).length,
    [items, selectedBySku]
  )

  const allVisibleSelected =
    items.length > 0 && items.every(i => i.sku && selectedBySku.has(i.sku.trim()))

  const someVisibleSelected =
    items.some(i => i.sku && selectedBySku.has(i.sku.trim())) && !allVisibleSelected

  useEffect(() => {
    const el = selectAllRef.current
    if (el) el.indeterminate = someVisibleSelected
  }, [someVisibleSelected])

  function sortIndicator(apiKey: string) {
    if (sortBy !== apiKey) return ""
    return sortDir === "desc" ? " ↓" : " ↑"
  }

  function handleSortClick(clickedSortBy: string) {
    const next = getNextSort(sortByRef.current, sortDirRef.current, clickedSortBy)
    if (process.env.NODE_ENV === "development") {
      console.log("[Listings Sort]", next)
    }
    sortByRef.current = next.sortBy
    sortDirRef.current = next.sortDir
    setSortBy(next.sortBy)
    setSortDir(next.sortDir)
    setCurrentPage(1)
    skipSortFetchEffectRef.current = true
    void fetchListings({ page: 1, sortBy: next.sortBy, sortDir: next.sortDir })
  }

  function toggleSelectAll() {
    if (allVisibleSelected) {
      setSelectedBySku(prev => {
        const next = new Map(prev)
        for (const item of items) {
          const sku = item.sku?.trim()
          if (sku) next.delete(sku)
        }
        return next
      })
    } else {
      setSelectedBySku(prev => {
        const next = new Map(prev)
        for (const item of items) {
          const sku = item.sku?.trim()
          if (sku) {
            next.set(sku, { ebayItemId: item.ebayItemId?.trim() ?? "", catalogStateId: item.catalogStateId })
          }
        }
        return next
      })
    }
  }

  function toggleItemSelection(item: MonitorItem) {
    const sku = item.sku?.trim()
    if (!sku) return
    setSelectedBySku(prev => {
      const next = new Map(prev)
      if (next.has(sku)) next.delete(sku)
      else next.set(sku, { ebayItemId: item.ebayItemId?.trim() ?? "", catalogStateId: item.catalogStateId })
      return next
    })
  }

  async function refetchCurrentListings() {
    await fetchListings({
      page: currentPage,
      sortBy: sortByRef.current,
      sortDir: sortDirRef.current,
    })
  }

  async function handleSetQty0(item: MonitorItem) {
    const sku = item.sku?.trim()
    if (!sku) return
    try {
      const res = await postMonitorBlind(selectedStore, sku)
      if (res.success && !res.simulation) {
        setItems(prev =>
          prev.map(i => (i.sku === sku ? { ...i, quantity: 0 } : i))
        )
      }
      if (res.simulation) {
        showToast("Simulation mode — eBay and panel DB not updated.", "error")
      } else if (res.updatedDb) {
        showToast("Quantity set to 0 and panel updated.", "success")
      } else if (res.success) {
        showToast("Quantity set to 0 on eBay, panel will refresh after sync.", "success")
      } else {
        showToast(res.message || "Set Qty 0 failed", "error")
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Set Qty 0 failed", "error")
    }
  }

  async function handleSetQty1(item: MonitorItem) {
    const sku = item.sku?.trim()
    if (!sku) return
    try {
      const res = await postMonitorUpdateStock(selectedStore, sku, 1)
      if (res.success && !res.simulation) {
        setItems(prev =>
          prev.map(i => (i.sku === sku ? { ...i, quantity: 1 } : i))
        )
      }
      if (res.simulation) {
        showToast("Simulation mode — eBay and panel DB not updated.", "error")
      } else if (res.updatedDb) {
        showToast("Quantity set to 1 and panel updated.", "success")
      } else if (res.success) {
        showToast("Quantity set to 1 on eBay, panel will refresh after sync.", "success")
      } else {
        showToast(res.message || "Set Qty 1 failed", "error")
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Set Qty 1 failed", "error")
    }
  }

  function stockGuardRefForItem(item: MonitorItem): { ebayItemId?: string; catalogStateId?: number } | null {
    const ebayId = item.ebayItemId?.trim()
    if (ebayId) return { ebayItemId: ebayId }
    if (item.catalogStateId != null && item.catalogStateId > 0) {
      return { catalogStateId: item.catalogStateId }
    }
    return null
  }

  async function handleStockGuardForRefs(
    refs: { ebayItemId?: string; catalogStateId?: number }[],
    enabled: boolean
  ) {
    if (refs.length === 0) {
      showToast("Selected listings have no eBay ID or catalog row", "error")
      return false
    }
    setBulkBusy(true)
    try {
      const res = await postListingsStockGuard(selectedStore, refs, enabled)
      if (res.updated > 0) {
        const updatedEbayIds = new Set(
          res.results.filter(r => r.status === "UPDATED" && r.ebayItemId).map(r => r.ebayItemId!)
        )
        const updatedCatalogIds = new Set(
          res.results
            .filter(r => r.status === "UPDATED" && r.catalogStateId != null)
            .map(r => r.catalogStateId!)
        )
        setItems(prev =>
          prev.map(i => {
            const ebayId = i.ebayItemId?.trim()
            const catalogId = i.catalogStateId
            const hit =
              (ebayId && updatedEbayIds.has(ebayId)) ||
              (catalogId != null && updatedCatalogIds.has(catalogId))
            return hit ? { ...i, stockGuardEnabled: enabled } : i
          })
        )
      }
      if (res.notFound === 0) {
        showToast(
          enabled
            ? `Added ${res.updated} listing(s) to Stock Guard`
            : `Stopped tracking ${res.updated} listing(s)`,
          "success"
        )
      } else {
        showToast(
          `${res.updated} updated, ${res.notFound} not found`,
          res.updated > 0 ? "success" : "error"
        )
      }
      return res.updated > 0
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Stock Guard update failed", "error")
      return false
    } finally {
      setBulkBusy(false)
    }
  }

  async function handleStockGuardForItems(
    targetItems: MonitorItem[],
    enabled: boolean
  ) {
    const refs = targetItems
      .map(stockGuardRefForItem)
      .filter((ref): ref is { ebayItemId?: string; catalogStateId?: number } => ref != null)
    await handleStockGuardForRefs(refs, enabled)
  }

  async function handleStockGuard(item: MonitorItem, enabled: boolean) {
    const ref = stockGuardRefForItem(item)
    if (!ref) {
      showToast("Listing has no eBay ID or catalog row", "error")
      return
    }
    await handleStockGuardForRefs([ref], enabled)
  }

  async function handleStopTracking(item: MonitorItem) {
    await handleStockGuard(item, false)
  }

  function requestEndListing(selected: Map<string, SelectedListingMeta>) {
    if (selected.size === 0) return
    const endItems = endItemsFromSelection(selected)
    if (endItems.length === 0) {
      showToast("Selected listings have no eBay ID or catalog row", "error")
      return
    }
    setPendingEndItems(endItems)
    setEndConfirmOpen(true)
  }

  function handleEndListing(item: MonitorItem) {
    const ebayId = item.ebayItemId?.trim()
    if (ebayId) {
      setPendingEndItems([{ ebayItemId: ebayId }])
      setEndConfirmOpen(true)
      return
    }
    if (item.catalogStateId != null && item.catalogStateId > 0) {
      setPendingEndItems([{ catalogStateId: item.catalogStateId }])
      setEndConfirmOpen(true)
      return
    }
    showToast("Listing has no eBay ID or catalog row", "error")
  }

  async function confirmEndListing() {
    const endItems = pendingEndItems
    if (!endItems || endItems.length === 0) {
      setEndConfirmOpen(false)
      return
    }
    setBulkBusy(true)
    try {
      const res = await postListingsEnd(selectedStore, endItems)

      if (res.ended > 0) {
        const endedEbayIds = new Set(
          res.results
            .filter(
              r =>
                (r.status === "ENDED_BY_OFFER" || r.status === "ENDED_BY_ITEM_ID") &&
                r.ebayItemId?.trim()
            )
            .map(r => r.ebayItemId!.trim())
        )
        const endedCatalogIds = new Set(
          res.results
            .filter(r => r.status === "ENDED_LOCALLY" && r.catalogStateId != null)
            .map(r => r.catalogStateId!)
        )
        setItems(prev =>
          prev.filter(i => {
            const ebayId = i.ebayItemId?.trim()
            if (ebayId && endedEbayIds.has(ebayId)) return false
            if (i.catalogStateId != null && endedCatalogIds.has(i.catalogStateId)) return false
            return true
          })
        )
        clearSelection()
        await refetchCurrentListings()
      }

      const simCount = res.results.filter(r => r.status === "SIMULATION").length
      const localCount = res.results.filter(r => r.status === "ENDED_LOCALLY").length
      if (simCount > 0 && res.ended === 0 && res.failed === 0) {
        showToast("Simulation mode — eBay and panel DB not updated.", "error")
      } else {
        const parts: string[] = []
        if (res.ended > 0) parts.push(`${res.ended} listing(s) ended`)
        if (localCount > 0) parts.push(`${localCount} ended locally (no eBay ID)`)
        if (res.failed > 0) parts.push(`${res.failed} failed to end`)
        if (res.notFound > 0) parts.push(`${res.notFound} not found`)
        showToast(
          parts.join(". ") + (parts.length ? "." : "No listings ended."),
          res.ended > 0 ? "success" : "error"
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "End listing failed"
      if (/token|expired|401|403/i.test(msg)) {
        showToast("eBay token expired — reconnect store in Settings", "error")
      } else {
        showToast(msg, "error")
      }
    } finally {
      setBulkBusy(false)
      setEndConfirmOpen(false)
      setPendingEndItems(null)
    }
  }

  function requestRemoveFromList(selected: Map<string, SelectedListingMeta>) {
    if (selected.size === 0) return
    setPendingRemoveSkus(new Set(selected.keys()))
    setRemoveConfirmOpen(true)
  }

  async function confirmRemoveFromList() {
    const skus = pendingRemoveSkus
    if (!skus || skus.size === 0) {
      setRemoveConfirmOpen(false)
      return
    }
    const ebayItems = ebayItemsFromSelectedMap(
      new Map([...skus].map(sku => [sku, selectedBySku.get(sku) ?? { ebayItemId: "", catalogStateId: null }]))
    )
    if (ebayItems.length === 0) {
      showToast("Selected listings have no eBay ID", "error")
      setRemoveConfirmOpen(false)
      setPendingRemoveSkus(null)
      return
    }
    setBulkBusy(true)
    const actionStore = selectedStoreRef.current
    try {
      const res = await postListingsRemoveFromList(actionStore, ebayItems)
      if (actionStore !== selectedStoreRef.current) return
      if (res.updated > 0) {
        const removedIds = new Set(
          res.results.filter(r => r.status === "UPDATED").map(r => r.ebayItemId)
        )
        setItems(prev => prev.filter(i => !removedIds.has(i.ebayItemId?.trim() ?? "")))
        clearSelection()
        await refetchCurrentListings()
      }
      if (res.notFound === 0) {
        showToast(`Removed ${res.updated} listing(s) from panel list`, "success")
      } else {
        showToast(
          `${res.updated} removed, ${res.notFound} not found`,
          res.updated > 0 ? "success" : "error"
        )
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Remove from list failed", "error")
    } finally {
      setBulkBusy(false)
      setRemoveConfirmOpen(false)
      setPendingRemoveSkus(null)
    }
  }

  function openUpdateSourceAsin(item: MonitorItem) {
    if (item.catalogStateId == null) {
      showToast("Catalog row id missing — sync listings first", "error")
      return
    }
    setSourceAsinTarget({
      catalogStateId: item.catalogStateId,
      currentAsin: item.asin,
      sku: item.sku,
    })
    setSourceAsinModalOpen(true)
  }

  function openUpdateEbayPrice(item: MonitorItem) {
    if (item.catalogStateId == null) {
      showToast("Catalog row id missing — sync listings first", "error")
      return
    }
    setEbayPriceTarget({
      catalogStateId: item.catalogStateId,
      currentEbayPrice: item.ebayPrice,
      amazonPrice: item.sourcePrice,
      sku: item.sku,
    })
    setEbayPriceModalOpen(true)
  }

  function handleEbayPriceSaved() {
    const tr = isUiTurkish()
    showToast(tr ? "eBay fiyatı güncellendi." : "eBay price updated.", "success")
    setEbayPriceModalOpen(false)
    setEbayPriceTarget(null)
    void fetchListings({
      page: currentPage,
      sortBy: sortByRef.current,
      sortDir: sortDirRef.current,
    })
  }

  function handleSourceAsinSaved(result: { newAsin: string; sourcePrice: number | null }) {
    const tr = isUiTurkish()
    showToast(tr ? "Kaynak ASIN güncellendi." : "Source ASIN updated.", "success")
    if (!sourceAsinTarget) return
    const id = sourceAsinTarget.catalogStateId
    setItems(prev =>
      prev.map(i =>
        i.catalogStateId === id
          ? {
              ...i,
              asin: result.newAsin,
              sourceUrl: `https://www.amazon.com/dp/${result.newAsin}`,
              sourceStatus: "AMAZON_OK",
              sourceStatusReason: "Source ASIN updated and verified",
              sourcePrice: result.sourcePrice,
              sourceCheckedAt: new Date().toISOString(),
            }
          : i
      )
    )
  }

  function handleRemoveFromList(item: MonitorItem) {
    const sku = item.sku?.trim()
    if (!sku) return
    requestRemoveFromList(
      new Map([[sku, { ebayItemId: item.ebayItemId?.trim() ?? "", catalogStateId: item.catalogStateId }]])
    )
  }

  function requestSyncListings() {
    setListingsSyncConfirmOpen(true)
  }

  async function confirmSyncListings() {
    setListingsSyncBusy(true)
    const actionStore = selectedStoreRef.current
    try {
      const res = await postListingsSyncListings(actionStore)
      if (actionStore !== selectedStoreRef.current) return

      const changed = res.inserted + res.updated
      if (changed > 0) {
        await fetchListings({
          page: 1,
          sortBy: sortByRef.current,
          sortDir: sortDirRef.current,
        })
        setCurrentPage(1)
      }

      if (res.syncHint && changed === 0) {
        showToast(res.syncHint, "error")
      } else if (res.errors > 0) {
        showToast(
          `Synced ${changed} listing(s) from eBay (${res.inserted} new, ${res.updated} updated). ${res.errors} failed.`,
          changed > 0 ? "success" : "error"
        )
      } else if (changed > 0) {
        showToast(
          `Synced ${res.tradingRows} eBay listing(s): ${res.inserted} new, ${res.updated} updated`,
          "success"
        )
      } else {
        showToast("No catalog changes — listings already up to date", "success")
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sync Listings failed"
      if (/no eBay account|not connected/i.test(msg)) {
        showToast("No eBay account connected for this store", "error")
      } else if (/token|expired|401|403/i.test(msg)) {
        showToast("eBay token expired — reconnect store in Settings", "error")
      } else {
        showToast(msg, "error")
      }
    } finally {
      setListingsSyncBusy(false)
      setListingsSyncConfirmOpen(false)
    }
  }

  function requestSyncMetrics() {
    setMetricsConfirmOpen(true)
  }

  async function confirmSyncMetrics() {
    setMetricsBusy(true)
    const actionStore = selectedStoreRef.current
    try {
      const selectedIds = ebayItemsFromSelectedMap(selectedBySku).map(i => i.ebayItemId)
      const res = await postListingsSyncMetrics(
        actionStore,
        selectedIds.length > 0 ? { ebayItemIds: selectedIds } : { mode: "all" }
      )
      if (actionStore !== selectedStoreRef.current) return

      if (res.updated > 0) {
        await fetchListings({
          page: currentPage,
          sortBy: sortByRef.current,
          sortDir: sortDirRef.current,
        })
      }

      if (!res.analyticsAvailable && res.analyticsError?.toLowerCase().includes("analytics")) {
        showToast(
          res.analyticsError ??
            "Analytics permission required — reconnect the store in Settings",
          "error"
        )
      } else if (res.syncHint && res.updated === 0) {
        showToast(res.syncHint, "error")
      } else if (res.updated === 0 && res.processed === 0) {
        showToast("No metrics available for sync", "error")
      } else if (res.updated > 0) {
        showToast(`Sales data updated for ${res.updated} listing(s)`, "success")
      } else {
        showToast("Sales data already up to date", "success")
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Metrics sync failed"
      if (/no eBay account|not connected/i.test(msg)) {
        showToast("No eBay account connected for this store", "error")
      } else if (/token|expired|401|403/i.test(msg)) {
        showToast("eBay token expired — reconnect store in Settings", "error")
      } else {
        showToast(msg, "error")
      }
    } finally {
      setMetricsBusy(false)
      setMetricsConfirmOpen(false)
    }
  }

  async function handleBulkApply() {
    if (!bulkAction || selectedCount === 0) return

    const actionMeta = BULK_ACTIONS.find(a => a.key === bulkAction)
    if (!actionMeta?.connected) {
      showToast(`${actionMeta?.label ?? bulkAction} — not connected yet`, "error")
      return
    }

    if (bulkAction === "remove_from_list") {
      requestRemoveFromList(selectedBySku)
      return
    }

    if (bulkAction === "end_listing") {
      requestEndListing(selectedBySku)
      return
    }

    if (bulkAction === "guard_on" || bulkAction === "guard_off") {
      const refs = stockGuardRefsFromSelection(selectedBySku)
      const ok = await handleStockGuardForRefs(refs, bulkAction === "guard_on")
      if (ok) {
        clearSelection()
        await refetchCurrentListings()
      }
      return
    }

    if (bulkAction === "set_qty_1") {
      setBulkBusy(true)
      const skus = [...selectedBySku.keys()]
      let ok = 0
      let fail = 0
      let dbUpdated = 0
      try {
        for (const sku of skus) {
          try {
            const res = await postMonitorUpdateStock(selectedStore, sku, 1)
            if (res.success && !res.simulation) ok++
            else fail++
            if (res.updatedDb && !res.simulation) dbUpdated++
          } catch {
            fail++
          }
        }
        if (ok > 0) {
          clearSelection()
          await refetchCurrentListings()
        }
        if (fail === 0) {
          showToast(
            dbUpdated === ok
              ? `Set Qty 1: ${ok} listing(s) — eBay and panel updated.`
              : `Set Qty 1: ${ok} on eBay — panel DB updated for ${dbUpdated}/${ok}.`,
            dbUpdated === ok ? "success" : "error"
          )
        } else {
          showToast(`Set Qty 1: ${ok} ok, ${fail} failed`, "error")
        }
      } finally {
        setBulkBusy(false)
      }
      return
    }

    if (bulkAction === "set_qty_0") {
      setBulkBusy(true)
      const skus = [...selectedBySku.keys()]
      let ok = 0
      let fail = 0
      let dbUpdated = 0
      try {
        for (const sku of skus) {
          try {
            const res = await postMonitorBlind(selectedStore, sku)
            if (res.success && !res.simulation) ok++
            else fail++
            if (res.updatedDb && !res.simulation) dbUpdated++
          } catch {
            fail++
          }
        }
        if (ok > 0) {
          clearSelection()
          await refetchCurrentListings()
        }
        if (fail === 0) {
          showToast(
            dbUpdated === ok
              ? `Set Qty 0: ${ok} listing(s) — eBay and panel updated.`
              : `Set Qty 0: ${ok} on eBay — panel DB updated for ${dbUpdated}/${ok}.`,
            dbUpdated === ok ? "success" : "error"
          )
        } else {
          showToast(`Set Qty 0: ${ok} ok, ${fail} failed`, "error")
        }
      } finally {
        setBulkBusy(false)
      }
    }
  }

  const syncStatusLine = useMemo(() => {
    if (!storeSyncInfo) return null
    const err = storeSyncInfo.syncError?.toLowerCase() ?? ""
    if (storeSyncInfo.syncStatus === "error") {
      if (/token|expired|401|403|connect|account/i.test(err)) {
        return { text: "Reconnect required", tone: "error" as const }
      }
      if (/metrics|sales/i.test(err)) {
        return { text: "Sales data update failed", tone: "error" as const }
      }
      return { text: "Store sync issue", tone: "error" as const }
    }
    const catalog = formatRelativeTime(storeSyncInfo.lastCatalogSyncAt)
    const metrics = formatRelativeTime(storeSyncInfo.lastMetricsSyncAt)
    const parts: string[] = []
    if (catalog) parts.push(`Listings updated ${catalog}`)
    if (metrics) parts.push(`Sales data updated ${metrics}`)
    if (parts.length === 0) return { text: "Sync scheduled", tone: "muted" as const }
    return { text: parts.join(" · "), tone: "muted" as const }
  }, [storeSyncInfo])

  const bulkConnected =
    bulkAction !== "" && BULK_ACTIONS.find(a => a.key === bulkAction)?.connected === true

  const selectStyle: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "3px",
    padding: "7px 10px",
    color: "var(--text)",
    fontSize: "11px",
    fontFamily: "'JetBrains Mono', monospace",
    outline: "none",
  }

  return (
    <div style={{ maxWidth: "100%", animation: "fade-in 0.3s ease forwards" }}>
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "10px",
          marginBottom: "16px",
          alignItems: "center",
          padding: "12px 14px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "4px",
        }}
      >
        <select
          aria-label="Store"
          value={selectedStore}
          onChange={e => setSelectedStore(e.target.value)}
          disabled={!isStoreReady || storeOptions.length === 0}
          style={{ ...selectStyle, minWidth: 140, color: "var(--accent)", fontWeight: 600 }}
        >
          {!isStoreReady || storeOptions.length === 0 ? (
            <option value="">Loading stores…</option>
          ) : null}
          {storeOptions.map(s => (
            <option key={s.storeCode} value={s.storeCode}>
              {s.name?.trim() || s.storeCode}
            </option>
          ))}
        </select>

        <select
          aria-label="Status filter"
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as StatusFilter)}
          style={{ ...selectStyle, minWidth: 160 }}
        >
          {STATUS_FILTERS.map(f => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>

        <input
          type="search"
          placeholder="Search title / ASIN / eBay ID"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            ...selectStyle,
            flex: "1 1 200px",
            minWidth: 180,
          }}
        />

        <select
          aria-label="Bulk action"
          value={bulkAction}
          onChange={e => setBulkAction(e.target.value as BulkAction)}
          style={{ ...selectStyle, minWidth: 160 }}
        >
          <option value="">Selected Actions</option>
          {BULK_ACTIONS.map(a => (
            <option key={a.key} value={a.key}>
              {a.label}
              {!a.connected ? " (soon)" : ""}
            </option>
          ))}
        </select>

        <button
          type="button"
          disabled={bulkBusy || selectedCount === 0 || !bulkAction || !bulkConnected}
          onClick={() => void handleBulkApply()}
          style={{
            ...mono,
            padding: "8px 18px",
            borderRadius: "3px",
            border: "none",
            background:
              selectedCount > 0 && bulkAction && bulkConnected
                ? "var(--accent)"
                : "var(--bg)",
            color:
              selectedCount > 0 && bulkAction && bulkConnected ? "#000" : "var(--dim)",
            fontWeight: 700,
            cursor:
              bulkBusy || selectedCount === 0 || !bulkAction || !bulkConnected
                ? "not-allowed"
                : "pointer",
            opacity:
              bulkBusy || selectedCount === 0 || !bulkAction || !bulkConnected ? 0.6 : 1,
          }}
        >
          {bulkBusy ? "Applying…" : "Apply"}
        </button>

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          {syncStatusLine && !loading ? (
            <span
              style={{
                ...mono,
                fontSize: 10,
                color:
                  syncStatusLine.tone === "error" ? "var(--danger)" : "var(--dim)",
                maxWidth: 360,
              }}
              title={storeSyncInfo?.syncError ?? undefined}
            >
              {syncStatusLine.text}
            </span>
          ) : null}
          <ToolbarMoreMenu
            disabled={!isStoreReady || loading}
            salesBusy={metricsBusy}
            listingsBusy={listingsSyncBusy}
            onUpdateSalesData={() => requestSyncMetrics()}
            onSyncListings={() => requestSyncListings()}
          />
        </div>
      </div>

      {selectedCount > 0 && (
        <div
          style={{
            ...mono,
            color: "var(--sub)",
            marginBottom: 8,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span>
            Selected: {selectedCount} listing{selectedCount === 1 ? "" : "s"}
            {selectedCount > currentPageSelectedCount ? " across pages" : ""}
          </span>
          <button
            type="button"
            onClick={clearSelection}
            style={{
              ...mono,
              padding: "4px 10px",
              border: "1px solid var(--border)",
              borderRadius: "3px",
              background: "var(--bg)",
              color: "var(--sub)",
              cursor: "pointer",
              fontSize: 10,
            }}
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Table */}
      <div
        style={{
          overflowX: "auto",
          border: "1px solid var(--border)",
          borderRadius: "4px",
          background: "var(--surface)",
        }}
      >
        {loading ? (
          <div
            style={{
              padding: "48px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
              color: "var(--dim)",
              ...mono,
            }}
          >
            <Spinner />
            Loading listings...
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: "48px", textAlign: "center", color: "var(--dim)", ...mono }}>
            {filteredTotal === 0 ? "No listings for this store" : "No results match filters"}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1100 }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, cursor: "default", width: 36 }}>
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    aria-label="Select all on this page"
                    style={{ accentColor: "var(--accent)" }}
                  />
                </th>
                <th style={{ ...thStyle, cursor: "default", width: 52 }}>Img</th>
                <th style={thStyle} onClick={() => handleSortClick("title")} title="Click to sort">
                  {SORT_LABELS.title}{sortIndicator("title")}
                </th>
                <th style={thStyle} onClick={() => handleSortClick("asin")} title="Click to sort">
                  {SORT_LABELS.asin}{sortIndicator("asin")}
                </th>
                <th style={thStyle} onClick={() => handleSortClick("ebayItemId")} title="Click to sort">
                  {SORT_LABELS.ebay_item_id}{sortIndicator("ebayItemId")}
                </th>
                <th style={thStyle} onClick={() => handleSortClick("quantity")} title="Click to sort">
                  {SORT_LABELS.quantity}{sortIndicator("quantity")}
                </th>
                <th style={thStyle} onClick={() => handleSortClick("ebayPrice")} title="Click to sort">
                  {SORT_LABELS.price}{sortIndicator("ebayPrice")}
                </th>
                <th style={thStyle} onClick={() => handleSortClick("sourcePrice")} title="Click to sort">
                  {SORT_LABELS.amazon_price}{sortIndicator("sourcePrice")}
                </th>
                <th style={thStyle} onClick={() => handleSortClick("sourceStatus")} title="Click to sort">
                  {SORT_LABELS.source_status}{sortIndicator("sourceStatus")}
                </th>
                <th style={thStyle} onClick={() => handleSortClick("listedAt")} title="Click to sort">
                  {SORT_LABELS.upload_date}{sortIndicator("listedAt")}
                </th>
                <th style={thStyle} onClick={() => handleSortClick("totalSold")} title="Click to sort">
                  {SORT_LABELS.total_sold}{sortIndicator("totalSold")}
                </th>
                <th style={thStyle} onClick={() => handleSortClick("clicks30d")} title="Click to sort">
                  {SORT_LABELS.clicks_30d}{sortIndicator("clicks30d")}
                </th>
                <th style={{ ...thStyle, cursor: "default", width: 48 }} />
              </tr>
            </thead>
            <tbody>
              {items.map(item => {
                const sku = item.sku?.trim() || ""
                const src = deriveSourceStatus(item)
                const amazonUrl = getAmazonUrl(item)
                const ebayUrl = getEbayUrl(item)
                const selected = Boolean(sku && selectedBySku.has(sku))

                return (
                  <tr
                    key={sku || `${item.ebayItemId ?? "row"}-${item.title?.slice(0, 20) ?? ""}`}
                    style={{
                      background: selected ? "rgba(0,255,136,0.04)" : "transparent",
                    }}
                  >
                    <td style={tdStyle}>
                      {sku ? (
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleItemSelection(item)}
                          style={{ accentColor: "var(--accent)" }}
                        />
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      <div
                        style={{
                          width: 40,
                          height: 40,
                          background: "var(--bg)",
                          borderRadius: 3,
                          overflow: "hidden",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {item.image ? (
                          <img
                            src={item.image}
                            alt=""
                            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                          />
                        ) : (
                          <span style={{ opacity: 0.3, fontSize: 14 }}>📦</span>
                        )}
                      </div>
                    </td>
                    <td style={{ ...tdStyle, maxWidth: 220 }}>
                      <span
                        title={item.title?.trim() || "—"}
                        style={{
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                          lineHeight: 1.35,
                          fontSize: 12,
                        }}
                      >
                        {item.title?.trim() || "—"}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      {item.asin?.trim() ? (
                        amazonUrl ? (
                          <a
                            href={amazonUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "var(--info)", textDecoration: "underline" }}
                          >
                            {item.asin}
                          </a>
                        ) : (
                          item.asin
                        )
                      ) : (
                        <span style={{ color: "var(--dim)" }}>No ASIN</span>
                      )}
                    </td>
                    <td style={tdStyle}>
                      {ebayUrl ? (
                        <a
                          href={ebayUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "var(--sub)", textDecoration: "underline" }}
                        >
                          {item.ebayItemId}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={tdStyle}>{Number.isFinite(item.quantity) ? item.quantity : "—"}</td>
                    <td style={tdStyle}>
                      <span title={ebayPriceTooltip(item)} style={{ cursor: ebayPriceTooltip(item) ? "help" : undefined }}>
                        {formatPrice(item)}
                      </span>
                      {ebayPriceTooltip(item) ? (
                        <div style={{ fontSize: 9, color: "var(--dim)", marginTop: 2 }}>{ebayPriceTooltip(item)}</div>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      <div>{formatAmazonPrice(item)}</div>
                      {formatSourceCheckedAgo(item.sourceCheckedAt) ? (
                        <div style={{ fontSize: 9, color: "var(--dim)", marginTop: 2 }}>
                          {formatSourceCheckedAgo(item.sourceCheckedAt)}
                        </div>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      <span
                        title={src.reason || undefined}
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: 20,
                          fontSize: 10,
                          fontWeight: 700,
                          color: SOURCE_BADGE_COLORS[src.key],
                          background: "var(--bg)",
                          border: `1px solid ${SOURCE_BADGE_COLORS[src.key]}`,
                        }}
                      >
                        {src.label}
                      </span>
                      {src.reason ? (
                        <div style={{ fontSize: 9, color: "var(--dim)", marginTop: 2 }}>
                          {src.reason}
                        </div>
                      ) : null}
                    </td>
                    <td style={tdStyle}>{formatDate(item.listedAt)}</td>
                    <td style={tdStyle}>{formatSoldCount(item.totalSold)}</td>
                    <td style={tdStyle}>
                      {(() => {
                        const clicks = formatClicksCell(item)
                        return (
                          <div title={clicks.title}>
                            <span
                              style={{
                                color: clicks.display === "—" ? "var(--dim)" : undefined,
                                cursor: clicks.title ? "help" : undefined,
                              }}
                            >
                              {clicks.display}
                            </span>
                            {clicks.sub ? (
                              <div style={{ fontSize: 9, color: "var(--dim)", marginTop: 2 }}>
                                {clicks.sub}
                              </div>
                            ) : null}
                          </div>
                        )
                      })()}
                    </td>
                    <td style={tdStyle}>
                      <RowActionMenu
                        item={item}
                        onSetQty0={handleSetQty0}
                        onSetQty1={handleSetQty1}
                        onEndListing={handleEndListing}
                        onRemoveFromList={handleRemoveFromList}
                        onStockGuard={handleStockGuard}
                        onStopTracking={handleStopTracking}
                        onUpdateSourceAsin={openUpdateSourceAsin}
                        onUpdateEbayPrice={openUpdateEbayPrice}
                        busy={bulkBusy}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {!loading && totalPages > 1 && (
        <div
          style={{
            marginTop: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            ...mono,
            color: "var(--sub)",
          }}
        >
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            style={selectStyle}
          >
            ← Prev
          </button>
          <span>
            Page {currentPage} of {totalPages}
          </span>
          <button
            type="button"
            disabled={currentPage >= totalPages}
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            style={selectStyle}
          >
            Next →
          </button>
        </div>
      )}

      <p style={{ ...mono, color: "var(--dim)", marginTop: 12, fontSize: 10 }}>
        {items.length} shown · {filteredTotal} matching
      </p>

      <ConfirmModal
        open={endConfirmOpen}
        title="End Listing on eBay"
        message="Selected listings will be ended on eBay. This cannot be undone from this screen."
        confirmLabel={bulkBusy ? "Ending…" : "End on eBay"}
        busy={bulkBusy}
        variant="danger"
        onCancel={() => {
          if (!bulkBusy) {
            setEndConfirmOpen(false)
            setPendingEndItems(null)
          }
        }}
        onConfirm={() => void confirmEndListing()}
      />

      <ConfirmModal
        open={removeConfirmOpen}
        title="Remove from List"
        message="Selected listings will be removed from this panel only. eBay will not be changed."
        confirmLabel={bulkBusy ? "Removing…" : "Remove"}
        busy={bulkBusy}
        variant="danger"
        onCancel={() => {
          if (!bulkBusy) {
            setRemoveConfirmOpen(false)
            setPendingRemoveSkus(null)
          }
        }}
        onConfirm={() => void confirmRemoveFromList()}
      />

      <ConfirmModal
        open={listingsSyncConfirmOpen}
        title="Sync Listings"
        message={`Pull active eBay listings into the panel for store ${selectedStore || "—"}? This uses that store's eBay token only — no data is copied from other stores.`}
        confirmLabel={listingsSyncBusy ? "Syncing…" : "Sync from eBay"}
        busy={listingsSyncBusy}
        variant="accent"
        onCancel={() => {
          if (!listingsSyncBusy) setListingsSyncConfirmOpen(false)
        }}
        onConfirm={() => void confirmSyncListings()}
      />

      <ConfirmModal
        open={metricsConfirmOpen}
        title="Update sales data"
        message={
          selectedCount > 0
            ? `Update sold and click metrics for ${selectedCount} selected listing(s)?`
            : "Update sold and click metrics for listings in this store? New listings are not imported from eBay."
        }
        confirmLabel={metricsBusy ? "Updating…" : "Update"}
        busy={metricsBusy}
        variant="accent"
        onCancel={() => {
          if (!metricsBusy) setMetricsConfirmOpen(false)
        }}
        onConfirm={() => void confirmSyncMetrics()}
      />

      <UpdateSourceAsinModal
        open={sourceAsinModalOpen}
        storeCode={selectedStore}
        target={sourceAsinTarget}
        onClose={() => {
          setSourceAsinModalOpen(false)
          setSourceAsinTarget(null)
        }}
        onSaved={handleSourceAsinSaved}
      />

      <UpdateEbayPriceModal
        open={ebayPriceModalOpen}
        storeCode={selectedStore}
        target={ebayPriceTarget}
        onClose={() => {
          setEbayPriceModalOpen(false)
          setEbayPriceTarget(null)
        }}
        onSaved={handleEbayPriceSaved}
      />
    </div>
  )
}
