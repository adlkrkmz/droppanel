"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { fetchAuthMe, type UserPublic } from "@/lib/userAuthClient"
import {
  fetchAppStockAlerts,
  fetchAppStores,
  ignoreAppStockAlert,
  bulkIgnoreAppStockAlerts,
  bulkApproveZeroAppStockAlerts,
  approveZeroAppStockAlert,
  setAppListingQuantity,
  bulkSetAppListingQuantity,
  updateAppListingStockGuard,
  bulkUpdateAppListingStockGuard,
  updateAppListingPrice,
  updateAppListingSourceAsin,
  type AppStockAlertItem,
  type AppBulkIgnoreStockAlertsResponse,
  type AppBulkApproveZeroStockAlertsResponse,
  type AppBulkSetListingQuantityResponse,
  type AppBulkListingStockGuardResponse,
  type AppStockAlertRisk,
  type AppStockAlertStatus,
  type AppStoreSummary,
} from "@/lib/userAppClient"
import {
  buildUserSelectedStockAlertsCsv,
  downloadCsvFile,
  formatUserSelectedStockAlertsFilename,
} from "@/lib/listingsUtils"
import {
  BULK_APPROVE_ZERO_MAX,
  BULK_IGNORE_MAX,
  bulkOverLimitTitle,
  formatBulkBatchRef,
  getBulkResultOutcomeMessage,
} from "@/lib/bulkActionsUi"
import { NoStoreEmptyState } from "@/components/app/NoStoreEmptyState"
import { AppEmptyState } from "@/components/app/AppEmptyState"
import { AppHelpBox } from "@/components/app/AppHelpBox"
import { useFocusRefetch } from "@/components/app/useFocusRefetch"
import { formatSourceStatusReasonForUi, formatStockAlertStatusLabel, formatVerificationSourceLabel } from "@/lib/sourceStatusDisplay"
import {
  adoptStoreSelection,
  parseUrlStoreId,
  storeCodeForId,
  useAppStoreSelection,
} from "@/lib/appStoreSelection"

const PAGE_LIMIT = 50
const BULK_QTY1_MAX = 10
const BULK_STOP_TRACKING_MAX = 20
const PROCESSING_POLL_MS = 5000
const PAGE_ONE_POLL_MS = 15000

const PRICE_INCREASE_STATUS = "PRICE_INCREASE"
const ASIN_INPUT_RE = /^[A-Z0-9]{10}$/

const STATUS_OPTIONS: { value: AppStockAlertStatus; label: string }[] = [
  { value: "pending",    label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "actioned",   label: "Actioned" },
  { value: "ignored",    label: "Ignored" },
  { value: "failed",     label: "Failed" },
  { value: "all",        label: "All" },
]

const RISK_FILTER_OPTIONS: { value: AppStockAlertRisk; label: string }[] = [
  { value: "all",                 label: "All risks" },
  { value: "needs-review",        label: "Needs review" },
  { value: "price-increase",      label: "Price increase" },
  { value: "source-unavailable",  label: "Source unavailable" },
  { value: "no-trusted-price",    label: "No trusted price" },
  { value: "check-failed",        label: "Check failed" },
]

const VALID_STATUSES = new Set<AppStockAlertStatus>([
  "pending",
  "processing",
  "actioned",
  "ignored",
  "failed",
  "all",
])
const VALID_RISK_FILTERS = new Set<AppStockAlertRisk>(RISK_FILTER_OPTIONS.map(o => o.value))

type SourceStatusMeta = {
  label:   string
  hint:    string
  variant: "danger" | "warn" | "dim" | "purple" | "neutral"
}

const SOURCE_STATUS_META: Record<string, SourceStatusMeta> = {
  PRICE_INCREASE:  { label: "Price increased",  hint: "Source price increased. Review profit margin.", variant: "danger" },
  NO_PRICE:        { label: "No source price",  hint: "We could not find a trusted source price.", variant: "warn" },
  UNAVAILABLE:     { label: "Unavailable",      hint: "Source product may be unavailable.", variant: "purple" },
  REMOVED:         { label: "Removed",            hint: "Source product may have been removed.", variant: "neutral" },
  PRICE_UNCERTAIN: { label: "Price uncertain",    hint: "Source price is not reliable enough.", variant: "warn" },
  CHECK_FAILED:    { label: "Check failed",       hint: "Source check failed. Try again later.", variant: "danger" },
}

function dash(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—"
  return String(v)
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `$${n.toFixed(2)}`
}

function fmtPercent(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const sign = n > 0 ? "+" : ""
  return `${sign}${n.toFixed(1)}%`
}

function parseAlertTimestamp(s: string | null | undefined): Date | null {
  if (!s?.trim()) return null
  const raw = s.trim()
  const iso = raw.includes("T")
    ? raw
    : raw.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00").replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d
}

function formatAlertClock(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0")
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const yyyy = String(d.getFullYear())
  const hh = String(d.getHours()).padStart(2, "0")
  const min = String(d.getMinutes()).padStart(2, "0")
  return `${dd}.${mm}.${yyyy} ${hh}:${min}`
}

function AlertTimeCell({ value }: { value: string | null | undefined }) {
  const [label, setLabel] = useState("—")
  const [title, setTitle] = useState<string | undefined>(undefined)
  useEffect(() => {
    const d = parseAlertTimestamp(value)
    if (!d) {
      setLabel("—")
      setTitle(undefined)
      return
    }
    setLabel(formatAlertClock(d))
    setTitle(formatAlertClock(d))
  }, [value])
  return (
    <span title={title} style={{ whiteSpace: "nowrap", display: "inline-block" }}>
      {label}
    </span>
  )
}

function normalizeSourceStatus(status: string | null | undefined): string {
  return status?.trim().toUpperCase().replace(/\s+/g, "_") ?? ""
}

function getSourceStatusMeta(status: string | null | undefined): SourceStatusMeta {
  const key = normalizeSourceStatus(status)
  if (SOURCE_STATUS_META[key]) return SOURCE_STATUS_META[key]!
  return {
    label:   "Needs review",
    hint:    "Review this alert and confirm your source pricing.",
    variant: "dim",
  }
}

function normalizeAsinInput(raw: string): string {
  return raw.trim().toUpperCase()
}

function safeApiError(msg: string | null | undefined, fallback: string): string {
  const t = msg?.trim()
  if (t && t.length <= 120 && !/stack|trace|oauth|token|ebay api|keepa/i.test(t)) return t
  return fallback
}

function amazonUrl(asin: string | null | undefined): string | null {
  const a = asin?.trim()
  if (!a) return null
  return `https://www.amazon.com/dp/${encodeURIComponent(a)}`
}

function ebayUrl(ebayItemId: string | null | undefined): string | null {
  const id = ebayItemId?.trim()
  if (!id) return null
  return `https://www.ebay.com/itm/${encodeURIComponent(id)}`
}

function canIgnoreAlert(item: AppStockAlertItem): boolean {
  const s = item.reviewStatus?.trim().toLowerCase() ?? ""
  return s === "pending" || s === "processing" || s === "failed"
}

function isBulkIgnoreEligible(item: AppStockAlertItem): boolean {
  if (!item.alertId || item.alertId <= 0) return false
  return canIgnoreAlert(item)
}

function isBulkIgnoreIneligible(item: AppStockAlertItem): boolean {
  if (!item.alertId || item.alertId <= 0) return false
  const s = item.reviewStatus?.trim().toLowerCase() ?? ""
  return s === "actioned" || s === "ignored"
}

function canApproveZeroAlert(item: AppStockAlertItem): boolean {
  if (!item.alertId) return false
  if (!canIgnoreAlert(item)) return false
  const src = normalizeSourceStatus(item.sourceStatus)
  return src !== "PRICE_INCREASE"
}

function isBulkApproveZeroIneligibleReason(item: AppStockAlertItem): string | null {
  if (!item.alertId || item.alertId <= 0) return "invalid"
  if (!item.catalogStateId || item.catalogStateId <= 0) return "invalid"
  const review = item.reviewStatus?.trim().toLowerCase() ?? ""
  if (review === "actioned" || review === "ignored") return review
  if (normalizeSourceStatus(item.sourceStatus) === PRICE_INCREASE_STATUS) {
    return "price_increase"
  }
  if (!canIgnoreAlert(item)) return "invalid"
  return null
}

function isBulkApproveZeroEligible(item: AppStockAlertItem): boolean {
  return isBulkApproveZeroIneligibleReason(item) === null
}

function hasCatalogState(item: AppStockAlertItem): boolean {
  return Boolean(item.catalogStateId && item.catalogStateId > 0)
}

function canSetQty1(item: AppStockAlertItem): boolean {
  return hasCatalogState(item) && canIgnoreAlert(item)
}

function canStopTracking(item: AppStockAlertItem): boolean {
  return hasCatalogState(item) && canIgnoreAlert(item)
}

function canUpdatePrice(item: AppStockAlertItem): boolean {
  if (!hasCatalogState(item) || !canIgnoreAlert(item)) return false
  return normalizeSourceStatus(item.sourceStatus) === PRICE_INCREASE_STATUS
}

function canUpdateAsin(item: AppStockAlertItem): boolean {
  return hasCatalogState(item) && canIgnoreAlert(item)
}

function isBulkQty1Eligible(item: AppStockAlertItem): boolean {
  return item.alertId > 0 && canSetQty1(item)
}

function isBulkStopTrackingEligible(item: AppStockAlertItem): boolean {
  return item.alertId > 0 && canStopTracking(item)
}

function getEmptyStateTitle(
  status: AppStockAlertStatus,
  risk: AppStockAlertRisk,
  searchQuery: string
): string {
  if (searchQuery) return "No alerts matched your search."
  if (risk === "price-increase") return "No price increase alerts found."
  if (risk === "source-unavailable") return "No unavailable source alerts found."
  if (risk === "no-trusted-price") return "No no-trusted-price alerts found."
  if (risk === "check-failed") return "No failed source checks found."
  if (risk === "needs-review") return "No alerts need review."
  if (status === "processing") return "No processing alerts found."
  if (status === "failed") return "No failed alerts found."
  return "No stock alerts found."
}

function hasActiveFilters(
  status: AppStockAlertStatus,
  risk: AppStockAlertRisk,
  searchQuery: string
): boolean {
  return status !== "all" || risk !== "all" || Boolean(searchQuery)
}

function parseStatus(raw: string | null): AppStockAlertStatus {
  const v = raw?.trim().toLowerCase() ?? ""
  return VALID_STATUSES.has(v as AppStockAlertStatus) ? (v as AppStockAlertStatus) : "all"
}

function parseRiskFilter(raw: string | null): AppStockAlertRisk {
  const v = raw?.trim().toLowerCase() ?? ""
  return VALID_RISK_FILTERS.has(v as AppStockAlertRisk) ? (v as AppStockAlertRisk) : "all"
}

function parseSearchQuery(raw: string | null): string {
  return raw?.trim().slice(0, 100) ?? ""
}

function syncUrl(
  storeCode: string,
  status: AppStockAlertStatus,
  page: number,
  risk: AppStockAlertRisk,
  searchQuery: string
) {
  const url = new URL(window.location.href)
  url.searchParams.set("storeCode", storeCode)
  url.searchParams.set("status", status)
  url.searchParams.set("page", String(page))
  if (risk === "all") {
    url.searchParams.delete("risk")
  } else {
    url.searchParams.set("risk", risk)
  }
  if (searchQuery) {
    url.searchParams.set("q", searchQuery)
  } else {
    url.searchParams.delete("q")
  }
  window.history.replaceState(null, "", url.pathname + url.search)
}

function parsePage(raw: string | null): number {
  const n = parseInt(raw ?? "1", 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

function pricingContextLine(item: AppStockAlertItem): string | null {
  if (normalizeSourceStatus(item.sourceStatus) !== PRICE_INCREASE_STATUS) return null
  const oldP = item.oldSourcePrice
  const newP = item.newSourcePrice ?? item.sourcePrice
  if (oldP == null && newP == null && item.priceChangePercent == null) return null
  const parts: string[] = []
  if (oldP != null || newP != null) {
    parts.push(`${fmtPrice(oldP)} → ${fmtPrice(newP)}`)
  }
  if (item.priceChangePercent != null) {
    parts.push(fmtPercent(item.priceChangePercent))
  }
  return parts.join(" · ")
}

export default function AppStockAlertsPage() {
  const router = useRouter()
  const { selectedStoreId, setSelectedStoreId, isStoreSelectionReady } = useAppStoreSelection()
  const selectedStoreIdRef = useRef(selectedStoreId)
  selectedStoreIdRef.current = selectedStoreId
  const alertsRequestSeqRef = useRef(0)
  const alertsAbortRef = useRef<AbortController | null>(null)
  const [user, setUser] = useState<UserPublic | null>(null)
  const [stores, setStores] = useState<AppStoreSummary[]>([])
  const [storeCode, setStoreCode] = useState("")
  const [status, setStatus] = useState<AppStockAlertStatus>("all")
  const [riskFilter, setRiskFilter] = useState<AppStockAlertRisk>("all")
  const [searchInput, setSearchInput] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [items, setItems] = useState<AppStockAlertItem[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [listLoading, setListLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ignoreModalItem, setIgnoreModalItem] = useState<AppStockAlertItem | null>(null)
  const [bulkIgnoreModalOpen, setBulkIgnoreModalOpen] = useState(false)
  const [bulkApproveZeroModalOpen, setBulkApproveZeroModalOpen] = useState(false)
  const [bulkQty1ModalOpen, setBulkQty1ModalOpen] = useState(false)
  const [bulkStopTrackingModalOpen, setBulkStopTrackingModalOpen] = useState(false)
  const [approveZeroModalItem, setApproveZeroModalItem] = useState<AppStockAlertItem | null>(null)
  const [qty1ModalItem, setQty1ModalItem] = useState<AppStockAlertItem | null>(null)
  const [stopTrackingModalItem, setStopTrackingModalItem] = useState<AppStockAlertItem | null>(null)
  const [updatePriceModalItem, setUpdatePriceModalItem] = useState<AppStockAlertItem | null>(null)
  const [updateAsinModalItem, setUpdateAsinModalItem] = useState<AppStockAlertItem | null>(null)
  const [selectedAlertIds, setSelectedAlertIds] = useState<Set<number>>(() => new Set())
  const selectAllAlertsRef = useRef<HTMLInputElement>(null)

  const selectableAlerts = useMemo(
    () => items.filter(item => item.alertId > 0),
    [items]
  )

  const selectedAlertsCount = selectedAlertIds.size

  const selectedAlertItems = useMemo(
    () => items.filter(item => item.alertId > 0 && selectedAlertIds.has(item.alertId)),
    [items, selectedAlertIds]
  )

  const bulkIgnoreEligibleCount = useMemo(
    () => selectedAlertItems.filter(isBulkIgnoreEligible).length,
    [selectedAlertItems]
  )

  const bulkIgnoreIneligibleCount = useMemo(
    () => selectedAlertItems.filter(isBulkIgnoreIneligible).length,
    [selectedAlertItems]
  )

  const canOpenBulkIgnore =
    Boolean(storeCode) &&
    selectedAlertsCount > 0 &&
    bulkIgnoreEligibleCount > 0 &&
    bulkIgnoreEligibleCount <= BULK_IGNORE_MAX

  const bulkApproveZeroPriceIncreaseCount = useMemo(
    () =>
      selectedAlertItems.filter(
        item => isBulkApproveZeroIneligibleReason(item) === "price_increase"
      ).length,
    [selectedAlertItems]
  )

  const bulkApproveZeroEligibleCount = useMemo(
    () => selectedAlertItems.filter(isBulkApproveZeroEligible).length,
    [selectedAlertItems]
  )

  const bulkApproveZeroIneligibleCount = useMemo(
    () => selectedAlertItems.filter(item => !isBulkApproveZeroEligible(item)).length,
    [selectedAlertItems]
  )

  const canOpenBulkApproveZero =
    Boolean(storeCode) &&
    selectedAlertsCount > 0 &&
    bulkApproveZeroEligibleCount > 0 &&
    bulkApproveZeroEligibleCount <= BULK_APPROVE_ZERO_MAX

  const bulkQty1EligibleCount = useMemo(
    () => selectedAlertItems.filter(isBulkQty1Eligible).length,
    [selectedAlertItems]
  )

  const canOpenBulkQty1 =
    Boolean(storeCode) &&
    selectedAlertsCount > 0 &&
    bulkQty1EligibleCount > 0 &&
    bulkQty1EligibleCount <= BULK_QTY1_MAX

  const bulkStopTrackingEligibleCount = useMemo(
    () => selectedAlertItems.filter(isBulkStopTrackingEligible).length,
    [selectedAlertItems]
  )

  const canOpenBulkStopTracking =
    Boolean(storeCode) &&
    selectedAlertsCount > 0 &&
    bulkStopTrackingEligibleCount > 0 &&
    bulkStopTrackingEligibleCount <= BULK_STOP_TRACKING_MAX

  const allSelectableAlertsSelected = useMemo(
    () =>
      selectableAlerts.length > 0 &&
      selectableAlerts.every(item => selectedAlertIds.has(item.alertId)),
    [selectableAlerts, selectedAlertIds]
  )

  const someSelectableAlertsSelected = useMemo(
    () =>
      selectableAlerts.some(item => selectedAlertIds.has(item.alertId)) &&
      !allSelectableAlertsSelected,
    [selectableAlerts, selectedAlertIds, allSelectableAlertsSelected]
  )

  const hasProcessingItems = useMemo(
    () => items.some(item => item.reviewStatus?.trim().toLowerCase() === "processing"),
    [items]
  )

  useEffect(() => {
    setSelectedAlertIds(new Set())
  }, [storeCode, status, riskFilter, searchQuery, page])

  useEffect(() => {
    setSelectedAlertIds(prev => {
      const visible = new Set(selectableAlerts.map(item => item.alertId))
      const next = new Set([...prev].filter(id => visible.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [selectableAlerts])

  useEffect(() => {
    const el = selectAllAlertsRef.current
    if (el) el.indeterminate = someSelectableAlertsSelected
  }, [someSelectableAlertsSelected, allSelectableAlertsSelected])

  const fetchAlertsData = useCallback(
    async (
      code: string,
      statusFilter: AppStockAlertStatus,
      pageNum: number,
      risk: AppStockAlertRisk,
      q: string,
      opts?: { silent?: boolean }
    ): Promise<boolean> => {
      if (!code) return false
      const silent = opts?.silent === true
      const requestId = ++alertsRequestSeqRef.current
      alertsAbortRef.current?.abort()
      const controller = new AbortController()
      alertsAbortRef.current = controller
      if (!silent) {
        setListLoading(true)
        setError(null)
      }

      let result
      try {
        result = await fetchAppStockAlerts({
          storeCode: code,
          page: pageNum,
          limit: PAGE_LIMIT,
          status: statusFilter,
          risk,
          q: q || undefined,
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted || requestId !== alertsRequestSeqRef.current) return false
        if (!silent) {
          setError(error instanceof Error ? error.message : "Failed to load stock alerts")
          setItems([])
          setTotal(0)
        }
        return false
      } finally {
        if (!silent && requestId === alertsRequestSeqRef.current) {
          setListLoading(false)
        }
      }

      if (controller.signal.aborted || requestId !== alertsRequestSeqRef.current) return false

      if (!result.ok) {
        if (result.status === 401) {
          router.replace("/app/login")
          return false
        }
        if (result.status === 403 && result.approvalStatus === "pending_approval") {
          router.replace("/pending-approval")
          return false
        }
        if (silent) {
          setError(prev => prev ?? result.error)
        } else {
          setError(result.error)
          setItems([])
        }
        return false
      }

      setItems(result.data.items)
      setTotal(result.data.total)
      setPage(result.data.page)
      if (result.data.page !== pageNum) {
        syncUrl(code, statusFilter, result.data.page, risk, q)
      }
      return true
    },
    [router]
  )

  useEffect(() => {
    return () => alertsAbortRef.current?.abort()
  }, [])

  const loadAlerts = useCallback(
    async (
      code: string,
      statusFilter: AppStockAlertStatus,
      pageNum: number,
      risk: AppStockAlertRisk,
      q: string
    ) => {
      await fetchAlertsData(code, statusFilter, pageNum, risk, q)
    },
    [fetchAlertsData]
  )

  const refreshStockAlerts = useCallback(async () => {
    if (!storeCode) return
    setRefreshing(true)
    const storesResult = await fetchAppStores()
    if (storesResult.ok) {
      setStores(storesResult.data.stores)
    }
    await fetchAlertsData(storeCode, status, page, riskFilter, searchQuery, { silent: true })
    setRefreshing(false)
  }, [storeCode, status, page, riskFilter, searchQuery, fetchAlertsData])

  const refreshAfterAction = useCallback(async () => {
    if (!storeCode) return
    await fetchAlertsData(storeCode, status, page, riskFilter, searchQuery)
    const storesResult = await fetchAppStores()
    if (storesResult.ok) {
      setStores(storesResult.data.stores)
    }
  }, [storeCode, status, page, riskFilter, searchQuery, fetchAlertsData])

  const hasActionUiOpen = Boolean(
    ignoreModalItem ||
    bulkIgnoreModalOpen ||
    bulkApproveZeroModalOpen ||
    bulkQty1ModalOpen ||
    bulkStopTrackingModalOpen ||
    approveZeroModalItem ||
    qty1ModalItem ||
    stopTrackingModalItem ||
    updatePriceModalItem ||
    updateAsinModalItem
  )

  useFocusRefetch(refreshStockAlerts, {
    enabled:
      !loading &&
      Boolean(storeCode) &&
      page === 1 &&
      selectedAlertIds.size === 0 &&
      !hasActionUiOpen,
  })

  useEffect(() => {
    if (!storeCode || page !== 1 || loading) return
    if (selectedAlertIds.size > 0 || hasActionUiOpen) return
    const intervalMs = hasProcessingItems ? PROCESSING_POLL_MS : PAGE_ONE_POLL_MS
    const tick = () => {
      if (document.visibilityState !== "visible") return
      void fetchAlertsData(storeCode, status, page, riskFilter, searchQuery, { silent: true })
    }
    const id = window.setInterval(tick, intervalMs)
    const onVis = () => {
      if (document.visibilityState === "visible") tick()
    }
    document.addEventListener("visibilitychange", onVis)
    return () => {
      window.clearInterval(id)
      document.removeEventListener("visibilitychange", onVis)
    }
  }, [
    storeCode,
    page,
    loading,
    selectedAlertIds.size,
    hasActionUiOpen,
    hasProcessingItems,
    status,
    riskFilter,
    searchQuery,
    fetchAlertsData,
  ])

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
    const adopted = adoptStoreSelection(list, {
      providerStoreId: selectedStoreIdRef.current,
      urlStoreId: parseUrlStoreId(params.get("storeId")),
      urlStoreCode: urlCode || null,
    })
    if (adopted.shouldWriteProvider && adopted.storeId != null) {
      setSelectedStoreId(adopted.storeId)
    }
    const validCode = storeCodeForId(list, adopted.storeId)
    const validStatus = parseStatus(params.get("status"))
    const validRisk = parseRiskFilter(params.get("risk"))
    const validSearch = parseSearchQuery(params.get("q"))
    const validPage = parsePage(params.get("page"))

    setStoreCode(validCode)
    setStatus(validStatus)
    setRiskFilter(validRisk)
    setSearchInput(validSearch)
    setSearchQuery(validSearch)
    setPage(validPage)
    setLoading(false)
    syncUrl(validCode, validStatus, validPage, validRisk, validSearch)
    await loadAlerts(validCode, validStatus, validPage, validRisk, validSearch)
  }, [router, loadAlerts, setSelectedStoreId])

  useEffect(() => {
    if (!isStoreSelectionReady) return
    void init()
  }, [isStoreSelectionReady, init])

  useEffect(() => {
    if (!isStoreSelectionReady || loading || stores.length === 0) return
    if (selectedStoreId == null) return
    const code = storeCodeForId(stores, selectedStoreId)
    if (!code || code === storeCode) return
    clearAlertSelection()
    setItems([])
    setTotal(0)
    setStoreCode(code)
    setPage(1)
    void loadAlerts(code, status, 1, riskFilter, searchQuery)
    syncUrl(code, status, 1, riskFilter, searchQuery)
  }, [selectedStoreId, stores, isStoreSelectionReady, loading, storeCode, status, riskFilter, searchQuery, loadAlerts])

  function handleStoreChange(storeIdRaw: string) {
    const id = Number(storeIdRaw)
    const store = stores.find(s => s.storeId === id)
    if (!store) return
    clearAlertSelection()
    setItems([])
    setTotal(0)
    setSelectedStoreId(id)
    setStoreCode(store.storeCode)
    setPage(1)
    void loadAlerts(store.storeCode, status, 1, riskFilter, searchQuery)
    syncUrl(store.storeCode, status, 1, riskFilter, searchQuery)
  }

  function handleStatusChange(next: AppStockAlertStatus) {
    clearAlertSelection()
    setStatus(next)
    setPage(1)
    void loadAlerts(storeCode, next, 1, riskFilter, searchQuery)
    syncUrl(storeCode, next, 1, riskFilter, searchQuery)
  }

  function handleRiskFilterChange(next: AppStockAlertRisk) {
    clearAlertSelection()
    setRiskFilter(next)
    setPage(1)
    void loadAlerts(storeCode, status, 1, next, searchQuery)
    syncUrl(storeCode, status, 1, next, searchQuery)
  }

  function applySearch() {
    const next = searchInput.trim().slice(0, 100)
    clearAlertSelection()
    setSearchQuery(next)
    setPage(1)
    void loadAlerts(storeCode, status, 1, riskFilter, next)
    syncUrl(storeCode, status, 1, riskFilter, next)
  }

  function clearSearch() {
    clearAlertSelection()
    setSearchInput("")
    setSearchQuery("")
    setPage(1)
    void loadAlerts(storeCode, status, 1, riskFilter, "")
    syncUrl(storeCode, status, 1, riskFilter, "")
  }

  function clearAlertSelection() {
    setSelectedAlertIds(new Set())
  }

  function toggleAlertSelection(alertId: number) {
    setSelectedAlertIds(prev => {
      const next = new Set(prev)
      if (next.has(alertId)) next.delete(alertId)
      else next.add(alertId)
      return next
    })
  }

  function toggleSelectAllAlertsOnPage() {
    if (allSelectableAlertsSelected) {
      clearAlertSelection()
      return
    }
    setSelectedAlertIds(new Set(selectableAlerts.map(item => item.alertId)))
  }

  function exportSelectedAlerts() {
    if (!storeCode || selectedAlertIds.size === 0) return
    const selected = items.filter(
      item => item.alertId > 0 && selectedAlertIds.has(item.alertId)
    )
    if (selected.length === 0) return
    const csv = buildUserSelectedStockAlertsCsv(
      selected.map(item => ({
        alertId:            item.alertId,
        catalogStateId:     item.catalogStateId,
        listingTitle:       item.listingTitle,
        asin:               item.asin,
        ebayItemId:         item.ebayItemId,
        sourceStatus:       item.sourceStatus,
        sourceStatusReason: item.sourceStatusReason,
        reviewStatus:       item.reviewStatus,
        ebayPrice:          item.ebayPrice,
        sourcePrice:        item.sourcePrice,
        oldSourcePrice:     item.oldSourcePrice,
        newSourcePrice:     item.newSourcePrice,
        priceChangePercent: item.priceChangePercent,
        ebayQuantity:       item.ebayQuantity,
        actionError:        item.actionError,
        createdAt:          item.createdAt,
        updatedAt:          item.updatedAt,
      }))
    )
    downloadCsvFile(csv, formatUserSelectedStockAlertsFilename(storeCode))
  }

  function handlePageChange(next: number) {
    if (next < 1) return
    const maxPage = Math.max(1, Math.ceil(total / PAGE_LIMIT))
    if (next > maxPage) return
    clearAlertSelection()
    void loadAlerts(storeCode, status, next, riskFilter, searchQuery)
    syncUrl(storeCode, status, next, riskFilter, searchQuery)
  }

  if (loading) {
    return <div style={{ padding: 48, textAlign: "center", color: "var(--dim)" }}>Loading…</div>
  }

  if (!user) return null

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT))
  const hasStores = stores.length > 0
  const listingsHref = `/app/listings?storeCode=${encodeURIComponent(storeCode)}`
  const importListingsHref = `/app/import?storeCode=${encodeURIComponent(storeCode)}`

  return (
    <div style={{ maxWidth: 1360, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <Link href="/app/dashboard" style={{ color: "var(--dim)", fontSize: 14, textDecoration: "none" }}>
          ← Dashboard
        </Link>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          marginBottom: 20,
        }}
      >
        <div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <h1 style={{ fontFamily: "'Syne', sans-serif", margin: 0, fontSize: 28 }}>Stock Alerts</h1>
            <span style={{ fontSize: 12, color: "var(--dim)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 8px" }}>
              Son 24 saat
            </span>
            {refreshing && (
              <span style={{ fontSize: 12, color: "var(--dim)" }}>Refreshing…</span>
            )}
            {hasProcessingItems && (
              <span style={{ fontSize: 11, color: "var(--accent, #60a5fa)" }}>Processing…</span>
            )}
          </div>
          <p style={{ color: "var(--dim)", margin: "8px 0 0", fontSize: 14 }}>
            Operational action queue for source price and stock risks.
          </p>
        </div>
        {hasStores && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <select
              value={selectedStoreId != null ? String(selectedStoreId) : ""}
              onChange={e => handleStoreChange(e.target.value)}
              aria-label="Store"
              style={selectStyle}
            >
              {stores.map(s => (
                <option key={s.storeId} value={s.storeId}>
                  {s.storeCode} — {s.name}
                </option>
              ))}
            </select>
            <select
              value={status}
              onChange={e => handleStatusChange(e.target.value as AppStockAlertStatus)}
              aria-label="Review status filter"
              style={selectStyle}
            >
              {STATUS_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <select
              value={riskFilter}
              onChange={e => handleRiskFilterChange(e.target.value as AppStockAlertRisk)}
              aria-label="Risk filter"
              style={selectStyle}
            >
              {RISK_FILTER_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <input
              type="search"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") applySearch()
              }}
              placeholder="Search ASIN, eBay ID, title…"
              aria-label="Search alerts"
              maxLength={100}
              style={searchInputStyle}
            />
            <button type="button" onClick={applySearch} disabled={listLoading} style={toolbarBtnStyle}>
              Search
            </button>
            {searchQuery && (
              <button type="button" onClick={clearSearch} disabled={listLoading} style={toolbarBtnStyle}>
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={() => void refreshStockAlerts()}
              disabled={listLoading || refreshing}
              style={toolbarBtnStyle}
            >
              {listLoading || refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <Link href={listingsHref} style={toolbarLinkStyle}>
              View Listings
            </Link>
            <Link href={`/app/stock-guard?storeCode=${encodeURIComponent(storeCode)}`} style={toolbarLinkStyle}>
              Stock Guard
            </Link>
          </div>
        )}
      </div>

      <AppHelpBox text="Stock Guard acts automatically when evidence is verified. Pending items are unresolved risks or retryable errors; Activity shows what Stock Guard detected, verified, or completed in the last 24 hours. Confirmed no valid Amazon source can set eBay quantity to 0, while unknown or incomplete evidence is not treated as unavailable." />

      {error && (
        <div style={errorBoxStyle}>
          <p style={{ margin: "0 0 12px" }}>{error}</p>
          <button
            type="button"
            onClick={() => (hasStores ? void refreshStockAlerts() : void init())}
            style={toolbarBtnStyle}
          >
            Retry
          </button>
        </div>
      )}

      {!hasStores ? (
        <NoStoreEmptyState
          description="Connect your eBay store to review source price and stock alerts."
        />
      ) : listLoading && items.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: "var(--dim)" }}>Loading alerts…</div>
      ) : total === 0 ? (
        <AppEmptyState
          title={getEmptyStateTitle(status, riskFilter, searchQuery)}
          description={
            hasActiveFilters(status, riskFilter, searchQuery)
              ? "Try a different status, risk filter, or search term."
              : "Alerts will appear here after your listings are imported and monitored."
          }
          primaryHref={hasActiveFilters(status, riskFilter, searchQuery) ? undefined : listingsHref}
          primaryLabel={hasActiveFilters(status, riskFilter, searchQuery) ? undefined : "View Listings"}
          secondaryLinks={
            hasActiveFilters(status, riskFilter, searchQuery)
              ? undefined
              : [{ href: importListingsHref, label: "Import Listings" }]
          }
        />
      ) : (
        <>
          {selectedAlertsCount > 0 && (
            <div className="app-bulk-toolbar">
              <span className="app-bulk-toolbar-count">{selectedAlertsCount} selected</span>
              <button
                type="button"
                className="app-bulk-toolbar-btn app-bulk-toolbar-btn--primary"
                onClick={exportSelectedAlerts}
              >
                Export Selected
              </button>
              <button type="button" className="app-bulk-toolbar-btn" onClick={clearAlertSelection}>
                Clear
              </button>
              <button
                type="button"
                className="app-bulk-toolbar-btn"
                disabled={!canOpenBulkIgnore}
                title={
                  bulkIgnoreEligibleCount > BULK_IGNORE_MAX
                    ? bulkOverLimitTitle(BULK_IGNORE_MAX)
                    : undefined
                }
                onClick={() => setBulkIgnoreModalOpen(true)}
              >
                Ignore selected
              </button>
              <button
                type="button"
                className="app-bulk-toolbar-btn app-bulk-toolbar-btn--danger"
                disabled={!canOpenBulkApproveZero}
                title={
                  bulkApproveZeroEligibleCount > BULK_APPROVE_ZERO_MAX
                    ? bulkOverLimitTitle(BULK_APPROVE_ZERO_MAX)
                    : `Max ${BULK_APPROVE_ZERO_MAX} per batch · writes to eBay`
                }
                onClick={() => setBulkApproveZeroModalOpen(true)}
              >
                Set Qty 0 selected (max {BULK_APPROVE_ZERO_MAX})
              </button>
              <button
                type="button"
                className="app-bulk-toolbar-btn"
                disabled={!canOpenBulkQty1}
                title={
                  bulkQty1EligibleCount > BULK_QTY1_MAX
                    ? bulkOverLimitTitle(BULK_QTY1_MAX)
                    : `Max ${BULK_QTY1_MAX} per batch · writes to eBay`
                }
                onClick={() => setBulkQty1ModalOpen(true)}
              >
                Qty 1 selected (max {BULK_QTY1_MAX})
              </button>
              <button
                type="button"
                className="app-bulk-toolbar-btn"
                disabled={!canOpenBulkStopTracking}
                title={
                  bulkStopTrackingEligibleCount > BULK_STOP_TRACKING_MAX
                    ? bulkOverLimitTitle(BULK_STOP_TRACKING_MAX)
                    : `Max ${BULK_STOP_TRACKING_MAX} per batch`
                }
                onClick={() => setBulkStopTrackingModalOpen(true)}
              >
                Stop Tracking selected (max {BULK_STOP_TRACKING_MAX})
              </button>
              {(bulkIgnoreEligibleCount > BULK_IGNORE_MAX ||
                bulkApproveZeroEligibleCount > BULK_APPROVE_ZERO_MAX ||
                bulkQty1EligibleCount > BULK_QTY1_MAX ||
                bulkStopTrackingEligibleCount > BULK_STOP_TRACKING_MAX) && (
                <span className="app-bulk-toolbar-hint">
                  Ignore max {BULK_IGNORE_MAX} · Qty 0/1 max {BULK_APPROVE_ZERO_MAX}/{BULK_QTY1_MAX} ·
                  Stop max {BULK_STOP_TRACKING_MAX}
                </span>
              )}
            </div>
          )}

          <div style={{ overflowX: "auto", marginBottom: 16 }}>
            <table style={tableStyle}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                  <th style={checkboxThStyle}>
                    <input
                      ref={selectAllAlertsRef}
                      type="checkbox"
                      className="app-table-checkbox"
                      checked={allSelectableAlertsSelected && selectableAlerts.length > 0}
                      disabled={selectableAlerts.length === 0 || listLoading}
                      onChange={toggleSelectAllAlertsOnPage}
                      aria-label="Select all alerts on this page"
                    />
                  </th>
                  <th style={{ ...thStyle, width: 56 }} aria-label="Image" />
                  <th style={thStyle}>Listing</th>
                  <th style={thStyle}>Source</th>
                  <th style={thStyle}>Reason</th>
                  <th style={thStyle}>Review</th>
                  <th style={thStyle}>eBay $</th>
                  <th style={thStyle}>Qty</th>
                  <th style={{ ...thStyle, whiteSpace: "nowrap" }}>İşlem Zamanı</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <AlertRow
                    key={item.alertId}
                    item={item}
                    selected={selectedAlertIds.has(item.alertId)}
                    onToggleSelect={() => toggleAlertSelection(item.alertId)}
                    onIgnore={() => setIgnoreModalItem(item)}
                    onApproveZero={() => setApproveZeroModalItem(item)}
                    onQty1={() => setQty1ModalItem(item)}
                    onStopTracking={() => setStopTrackingModalItem(item)}
                    onUpdatePrice={() => setUpdatePriceModalItem(item)}
                    onUpdateAsin={() => setUpdateAsinModalItem(item)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div style={paginationStyle}>
            <span>
              Page {page} of {totalPages} · {total} alert{total === 1 ? "" : "s"} · Son 24 saat
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => handlePageChange(page - 1)}
                disabled={page <= 1 || listLoading}
                style={pageBtnStyle}
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => handlePageChange(page + 1)}
                disabled={page >= totalPages || listLoading}
                style={pageBtnStyle}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}

      {ignoreModalItem && storeCode && (
        <IgnoreAlertModal
          item={ignoreModalItem}
          storeCode={storeCode}
          onClose={() => setIgnoreModalItem(null)}
          onSuccess={async () => {
            setIgnoreModalItem(null)
            await refreshAfterAction()
          }}
        />
      )}

      {bulkIgnoreModalOpen && storeCode && (
        <BulkIgnoreAlertsModal
          storeCode={storeCode}
          selectedItems={selectedAlertItems}
          eligibleCount={bulkIgnoreEligibleCount}
          ineligibleCount={bulkIgnoreIneligibleCount}
          onClose={() => setBulkIgnoreModalOpen(false)}
          onSuccess={async () => {
            setBulkIgnoreModalOpen(false)
            clearAlertSelection()
            await refreshAfterAction()
          }}
          onViewPending={() => {
            setBulkIgnoreModalOpen(false)
            clearAlertSelection()
            handleStatusChange("pending")
          }}
        />
      )}

      {bulkApproveZeroModalOpen && storeCode && (
        <BulkApproveZeroAlertsModal
          storeCode={storeCode}
          selectedItems={selectedAlertItems}
          eligibleCount={bulkApproveZeroEligibleCount}
          ineligibleCount={bulkApproveZeroIneligibleCount}
          priceIncreaseCount={bulkApproveZeroPriceIncreaseCount}
          onClose={() => setBulkApproveZeroModalOpen(false)}
          onSuccess={async () => {
            setBulkApproveZeroModalOpen(false)
            clearAlertSelection()
            await refreshAfterAction()
          }}
          onViewPending={() => {
            setBulkApproveZeroModalOpen(false)
            clearAlertSelection()
            handleStatusChange("pending")
          }}
          onViewActioned={() => {
            setBulkApproveZeroModalOpen(false)
            clearAlertSelection()
            handleStatusChange("actioned")
          }}
        />
      )}

      {bulkQty1ModalOpen && storeCode && (
        <BulkQty1AlertsModal
          storeCode={storeCode}
          selectedItems={selectedAlertItems}
          eligibleCount={bulkQty1EligibleCount}
          onClose={() => setBulkQty1ModalOpen(false)}
          onSuccess={async () => {
            setBulkQty1ModalOpen(false)
            clearAlertSelection()
            await refreshAfterAction()
          }}
        />
      )}

      {bulkStopTrackingModalOpen && storeCode && (
        <BulkStopTrackingModal
          storeCode={storeCode}
          selectedItems={selectedAlertItems}
          eligibleCount={bulkStopTrackingEligibleCount}
          onClose={() => setBulkStopTrackingModalOpen(false)}
          onSuccess={async () => {
            setBulkStopTrackingModalOpen(false)
            clearAlertSelection()
            await refreshAfterAction()
          }}
        />
      )}

      {approveZeroModalItem && storeCode && (
        <ApproveZeroModal
          item={approveZeroModalItem}
          storeCode={storeCode}
          onClose={() => setApproveZeroModalItem(null)}
          onSuccess={async () => {
            setApproveZeroModalItem(null)
            await refreshAfterAction()
          }}
        />
      )}

      {qty1ModalItem && storeCode && (
        <Qty1Modal
          item={qty1ModalItem}
          storeCode={storeCode}
          onClose={() => setQty1ModalItem(null)}
          onSuccess={async () => {
            setQty1ModalItem(null)
            await refreshAfterAction()
          }}
        />
      )}

      {stopTrackingModalItem && storeCode && (
        <StopTrackingModal
          item={stopTrackingModalItem}
          storeCode={storeCode}
          onClose={() => setStopTrackingModalItem(null)}
          onSuccess={async () => {
            setStopTrackingModalItem(null)
            await refreshAfterAction()
          }}
        />
      )}

      {updatePriceModalItem && storeCode && (
        <UpdatePriceModal
          item={updatePriceModalItem}
          storeCode={storeCode}
          onClose={() => setUpdatePriceModalItem(null)}
          onSuccess={async () => {
            setUpdatePriceModalItem(null)
            await refreshAfterAction()
          }}
        />
      )}

      {updateAsinModalItem && storeCode && (
        <UpdateAsinModal
          item={updateAsinModalItem}
          storeCode={storeCode}
          onClose={() => setUpdateAsinModalItem(null)}
          onSuccess={async () => {
            setUpdateAsinModalItem(null)
            await refreshAfterAction()
          }}
        />
      )}
    </div>
  )
}

function AlertRow({
  item,
  selected,
  onToggleSelect,
  onIgnore,
  onApproveZero,
  onQty1,
  onStopTracking,
  onUpdatePrice,
  onUpdateAsin,
}: {
  item: AppStockAlertItem
  selected: boolean
  onToggleSelect: () => void
  onIgnore: () => void
  onApproveZero: () => void
  onQty1: () => void
  onStopTracking: () => void
  onUpdatePrice: () => void
  onUpdateAsin: () => void
}) {
  const [detailOpen, setDetailOpen] = useState(false)
  const isPending = item.reviewStatus?.toLowerCase() === "pending"
  const canSelect = item.alertId > 0
  const imageUrl = item.imageUrl ?? null
  const reasonPrimary = formatSourceStatusReasonForUi(item.sourceStatus, item.sourceStatusReason)
  const pricingLine = pricingContextLine(item)
  const amz = amazonUrl(item.asin)
  const ebay = ebayUrl(item.ebayItemId)
  const fullReasonTitle = [reasonPrimary, pricingLine, item.sourceStatusReason, item.actionError]
    .filter(Boolean)
    .join("\n")

  const rowStyle: CSSProperties = {
    borderLeft: isPending ? "3px solid var(--accent, #60a5fa)" : "3px solid transparent",
    transition: "background 0.12s ease",
  }

  return (
    <tr
      style={rowStyle}
      onMouseEnter={e => {
        e.currentTarget.style.background = "rgba(148, 163, 184, 0.06)"
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = "transparent"
      }}
    >
      <td style={checkboxTdStyle}>
        <input
          type="checkbox"
          className="app-table-checkbox"
          checked={selected}
          disabled={!canSelect}
          onChange={onToggleSelect}
          aria-label={`Select alert ${item.alertId}`}
        />
      </td>
      <td style={{ ...tdStyle, width: 56, paddingRight: 4 }}>
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt=""
            width={48}
            height={48}
            style={{
              width: 48,
              height: 48,
              objectFit: "cover",
              borderRadius: 6,
              border: "1px solid var(--border)",
              display: "block",
              background: "rgba(148,163,184,0.08)",
            }}
          />
        ) : (
          <div
            aria-hidden
            style={{
              width: 48,
              height: 48,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "rgba(148,163,184,0.08)",
            }}
          />
        )}
      </td>
      <td style={{ ...tdStyle, maxWidth: 280, minWidth: 160 }}>
        <div style={{ fontWeight: isPending ? 600 : 500, lineHeight: 1.35, marginBottom: 4 }}>
          {dash(item.listingTitle)}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
          {amz ? (
            <a href={amz} target="_blank" rel="noreferrer" style={monoLinkStyle} title={item.asin}>
              {item.asin?.trim() || "ASIN"}
            </a>
          ) : (
            <span style={{ color: "var(--dim)" }}>—</span>
          )}
          {ebay ? (
            <a href={ebay} target="_blank" rel="noreferrer" style={monoLinkStyle} title={item.ebayItemId ?? undefined}>
              {item.ebayItemId}
            </a>
          ) : null}
        </div>
      </td>
      <td style={tdStyle}>
        <SourceStatusBadge
          status={item.sourceStatus}
          reviewStatus={item.reviewStatus}
          reason={item.sourceStatusReason}
        />
      </td>
      <td style={{ ...tdStyle, maxWidth: 220, fontSize: 12, lineHeight: 1.4 }} title={fullReasonTitle}>
        <div style={{ color: "inherit" }}>{reasonPrimary}</div>
        <div style={{ color: "var(--dim)", fontSize: 10, marginTop: 2 }}>Karar kaynağı: {formatVerificationSourceLabel(item.verificationSource)}</div>
        {pricingLine && (
          <div style={{ color: "var(--dim)", marginTop: 2, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
            {pricingLine}
          </div>
        )}
        {item.actionError && (
          <div style={{ color: "#e88", marginTop: 2, fontSize: 11 }} title={item.actionError}>
            {item.actionError.length > 60 ? `${item.actionError.slice(0, 59)}…` : item.actionError}
          </div>
        )}
        {(item.sourceStatusReason || pricingLine) && (
          <button
            type="button"
            onClick={() => setDetailOpen(v => !v)}
            style={detailToggleStyle}
          >
            {detailOpen ? "Hide detail" : "Detail"}
          </button>
        )}
        {detailOpen && (
          <div style={{ marginTop: 6, color: "var(--dim)", fontSize: 11, whiteSpace: "pre-wrap" }}>
            {item.sourceStatusReason?.trim() || reasonPrimary}
            {pricingLine ? `\n${pricingLine}` : ""}
          </div>
        )}
      </td>
      <td style={tdStyle}>
        <ReviewStatusBadge status={item.reviewStatus} />
      </td>
      <td style={tdStyle}>{fmtPrice(item.ebayPrice ?? item.currentDbPrice)}</td>
      <td style={tdStyle}>{dash(item.ebayQuantity)}</td>
      <td style={{ ...tdStyle, whiteSpace: "nowrap", fontSize: 12, color: "var(--dim)" }}>
        <AlertTimeCell value={item.createdAt} />
      </td>
      <td style={tdStyle}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, minWidth: 120, maxWidth: 200 }}>
          {canApproveZeroAlert(item) && (
            <button type="button" onClick={onApproveZero} style={actionDangerBtnStyle}>
              Qty 0
            </button>
          )}
          {canSetQty1(item) && (
            <button type="button" onClick={onQty1} style={actionBtnStyle}>
              Qty 1
            </button>
          )}
          {canIgnoreAlert(item) && (
            <button type="button" onClick={onIgnore} style={actionBtnStyle}>
              Ignore
            </button>
          )}
          {canStopTracking(item) && (
            <button type="button" onClick={onStopTracking} style={actionBtnStyle}>
              Stop Tracking
            </button>
          )}
          {canUpdatePrice(item) && (
            <button type="button" onClick={onUpdatePrice} style={actionAccentBtnStyle}>
              Update Price
            </button>
          )}
          {canUpdateAsin(item) && (
            <button type="button" onClick={onUpdateAsin} style={actionBtnStyle}>
              Update ASIN
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}

function SourceStatusBadge({
  status,
  reviewStatus,
  reason,
}: {
  status: string
  reviewStatus?: string | null
  reason?: string | null
}) {
  const meta = getSourceStatusMeta(status)
  const colors = VARIANT_COLORS[meta.variant]
  const label = formatStockAlertStatusLabel({ sourceStatus: status, reviewStatus, reason })

  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 600,
        background: colors.bg,
        color: colors.color,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  )
}

function ReviewStatusBadge({ status }: { status: string | null | undefined }) {
  const s = status?.trim().toLowerCase() ?? ""
  const isPending = s === "pending"
  const isProcessing = s === "processing"
  const isFailed = s === "failed"
  const colors = isPending
    ? { bg: "rgba(96, 165, 250, 0.12)", color: "var(--accent, #60a5fa)" }
    : isProcessing
      ? { bg: "rgba(59, 130, 246, 0.15)", color: "#60a5fa" }
      : isFailed
        ? { bg: "rgba(200, 60, 60, 0.15)", color: "#e88" }
        : s === "actioned"
          ? { bg: "rgba(60,180,120,0.15)", color: "#6c9" }
          : { bg: "rgba(148, 163, 184, 0.15)", color: "var(--dim)" }

  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 600,
        background: colors.bg,
        color: colors.color,
        textTransform: "capitalize",
      }}
    >
      {dash(status)}
    </span>
  )
}

function handleAuthRedirect(
  router: ReturnType<typeof useRouter>,
  status: number,
  approvalStatus?: string
): boolean {
  if (status === 401) {
    router.replace("/app/login")
    return true
  }
  if (status === 403 && approvalStatus === "pending_approval") {
    router.replace("/pending-approval")
    return true
  }
  return false
}

function BulkIgnoreAlertsModal({
  storeCode,
  selectedItems,
  eligibleCount,
  ineligibleCount,
  onClose,
  onSuccess,
  onViewPending,
}: {
  storeCode:        string
  selectedItems:    AppStockAlertItem[]
  eligibleCount:    number
  ineligibleCount:  number
  onClose:          () => void
  onSuccess:        () => Promise<void>
  onViewPending:    () => void
}) {
  const router = useRouter()
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AppBulkIgnoreStockAlertsResponse | null>(null)

  const selectedCount = selectedItems.length
  const skippedCount = ineligibleCount

  const alertIdsToSend = useMemo(
    () =>
      selectedItems
        .filter(isBulkIgnoreEligible)
        .slice(0, BULK_IGNORE_MAX)
        .map(item => item.alertId),
    [selectedItems]
  )

  const overLimit = eligibleCount > BULK_IGNORE_MAX

  async function handleBulkIgnore() {
    if (!confirmChecked || loading || eligibleCount === 0 || overLimit) return
    setLoading(true)
    setError(null)

    const apiResult = await bulkIgnoreAppStockAlerts({
      storeCode,
      alertIds: alertIdsToSend,
      confirm:  true,
    })

    setLoading(false)

    if (!apiResult.ok) {
      if (handleAuthRedirect(router, apiResult.status, apiResult.approvalStatus)) return
      setError(safeApiError(apiResult.error, "Could not ignore selected alerts."))
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
          aria-labelledby="bulk-ignore-result-title"
          onClick={e => e.stopPropagation()}
        >
          <div className="app-modal-header">
            <div>
              <h2 id="bulk-ignore-result-title" className="app-modal-title">
                Bulk ignore complete
              </h2>
              <p className="app-modal-subtitle">
                Selected alerts were processed. eBay listings, prices, and quantities were not changed.
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
                <li key={item.alertId}>
                  Alert #{item.alertId}: {item.error ?? "Could not ignore."}
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
            <button
              type="button"
              className="app-modal-primary-btn"
              onClick={() => {
                onViewPending()
              }}
            >
              View remaining pending alerts
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
        aria-labelledby="bulk-ignore-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="bulk-ignore-title" className="app-modal-title">
              Ignore selected alerts?
            </h2>
            <p className="app-modal-subtitle">
              This will mark selected alerts as ignored. It will not update eBay listings, prices, or
              quantities.
            </p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <ul className="app-modal-summary-list">
          <li>Selected: {selectedCount}</li>
          <li>Eligible: {eligibleCount}</li>
          <li>Will be skipped: {skippedCount}</li>
          <li>Max allowed per batch: {BULK_IGNORE_MAX}</li>
        </ul>

        {overLimit && (
          <p className="app-modal-warning">
            Select at most {BULK_IGNORE_MAX} eligible alerts per batch.
          </p>
        )}

        {ineligibleCount > 0 && (
          <p className="app-modal-warning">
            {ineligibleCount} selected alert{ineligibleCount === 1 ? "" : "s"} cannot be ignored
            because {ineligibleCount === 1 ? "it is" : "they are"} already actioned or ignored.
          </p>
        )}

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-apply-section">
          <h3 className="app-modal-apply-title">Confirm bulk ignore</h3>
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            I understand this only marks alerts as ignored.
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
            onClick={() => void handleBulkIgnore()}
          >
            {loading ? "Ignoring…" : "Ignore Selected"}
          </button>
        </div>
      </div>
    </div>
  )
}

function IgnoreAlertModal({
  item,
  storeCode,
  onClose,
  onSuccess,
}: {
  item: AppStockAlertItem
  storeCode: string
  onClose: () => void
  onSuccess: () => Promise<void>
}) {
  const router = useRouter()
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleIgnore() {
    if (!confirmChecked || loading) return
    setLoading(true)
    setError(null)

    const result = await ignoreAppStockAlert({
      storeCode,
      alertId: item.alertId,
      confirm: true,
    })

    setLoading(false)

    if (!result.ok) {
      if (handleAuthRedirect(router, result.status, result.approvalStatus)) return
      setError(safeApiError(result.error, "Could not ignore alert."))
      return
    }

    await onSuccess()
  }

  return (
    <div className="app-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="app-modal"
        role="dialog"
        aria-labelledby="ignore-alert-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="ignore-alert-title" className="app-modal-title">
              Ignore stock alert?
            </h2>
            <p className="app-modal-subtitle">
              This will mark the alert as ignored. It will not update your eBay listing, price, or
              quantity.
            </p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="app-modal-meta">
          {dash(item.listingTitle)} · ASIN {dash(item.asin)} · Alert #{item.alertId}
        </p>

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-apply-section">
          <h3 className="app-modal-apply-title">Confirm ignore</h3>
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            I understand this only hides this alert from pending review.
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
            onClick={() => void handleIgnore()}
          >
            {loading ? "Ignoring…" : "Ignore Alert"}
          </button>
        </div>
      </div>
    </div>
  )
}

function BulkApproveZeroAlertsModal({
  storeCode,
  selectedItems,
  eligibleCount,
  ineligibleCount,
  priceIncreaseCount,
  onClose,
  onSuccess,
  onViewPending,
  onViewActioned,
}: {
  storeCode:           string
  selectedItems:       AppStockAlertItem[]
  eligibleCount:       number
  ineligibleCount:     number
  priceIncreaseCount:  number
  onClose:             () => void
  onSuccess:           () => Promise<void>
  onViewPending:       () => void
  onViewActioned:      () => void
}) {
  const router = useRouter()
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [confirmationText, setConfirmationText] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AppBulkApproveZeroStockAlertsResponse | null>(null)

  const selectedCount = selectedItems.length
  const skippedCount = ineligibleCount
  const overLimit = eligibleCount > BULK_APPROVE_ZERO_MAX

  const alertIdsToSend = useMemo(
    () =>
      selectedItems
        .filter(isBulkApproveZeroEligible)
        .slice(0, BULK_APPROVE_ZERO_MAX)
        .map(item => item.alertId),
    [selectedItems]
  )

  const canSubmit =
    confirmChecked &&
    confirmationText.trim().toUpperCase() === "ZERO" &&
    !loading &&
    eligibleCount > 0 &&
    !overLimit

  async function handleSubmit() {
    if (!canSubmit) return
    setLoading(true)
    setError(null)

    const apiResult = await bulkApproveZeroAppStockAlerts({
      storeCode,
      alertIds:         alertIdsToSend,
      confirm:          true,
      confirmationText: "ZERO",
    })

    setLoading(false)

    if (!apiResult.ok) {
      if (handleAuthRedirect(router, apiResult.status, apiResult.approvalStatus)) return
      setError(safeApiError(apiResult.error, "Could not set selected listings quantity to 0."))
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
          aria-labelledby="bulk-approve-zero-result-title"
          onClick={e => e.stopPropagation()}
        >
          <div className="app-modal-header">
            <div>
              <h2 id="bulk-approve-zero-result-title" className="app-modal-title">
                Bulk quantity zero complete
              </h2>
              <p className="app-modal-subtitle">
                Eligible alerts were processed. Review any failures before continuing.
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
                <li key={item.alertId}>
                  Alert #{item.alertId}: {item.error ?? "Could not process."}
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
            <button type="button" className="app-modal-close-btn" onClick={onViewPending}>
              View remaining pending alerts
            </button>
            <button type="button" className="app-modal-primary-btn" onClick={onViewActioned}>
              View actioned alerts
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
        aria-labelledby="bulk-approve-zero-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="bulk-approve-zero-title" className="app-modal-title">
              Set selected listings quantity to 0?
            </h2>
            <p className="app-modal-subtitle">
              This will update eBay listing quantity to 0 for eligible selected alerts. Buyers will
              not be able to purchase those listings while quantity is 0.
            </p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="app-modal-warning">This action writes to eBay.</p>

        <ul className="app-modal-summary-list">
          <li>Selected: {selectedCount}</li>
          <li>Eligible: {eligibleCount}</li>
          <li>Will be skipped: {skippedCount}</li>
          <li>Max allowed per batch: {BULK_APPROVE_ZERO_MAX}</li>
        </ul>

        {overLimit && (
          <p className="app-modal-warning">
            Select at most {BULK_APPROVE_ZERO_MAX} eligible alerts per batch.
          </p>
        )}

        {ineligibleCount > 0 && (
          <p className="app-modal-meta">
            {ineligibleCount} selected alert{ineligibleCount === 1 ? "" : "s"} cannot be set to
            quantity 0.
          </p>
        )}

        {priceIncreaseCount > 0 && (
          <p className="app-modal-warning">
            {priceIncreaseCount} selected alert{priceIncreaseCount === 1 ? "" : "s"} excluded:
            Price increase alerts should be handled with price update.
          </p>
        )}

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-apply-section">
          <h3 className="app-modal-apply-title">Confirm quantity zero</h3>
          <label className="app-modal-apply-label" htmlFor="bulk-approve-zero-confirm-text">
            Type ZERO to confirm.
          </label>
          <input
            id="bulk-approve-zero-confirm-text"
            type="text"
            value={confirmationText}
            disabled={loading}
            onChange={e => setConfirmationText(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="app-modal-apply-input"
          />
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            I understand this will update eBay listing quantities.
          </label>
        </div>

        <div className="app-modal-footer app-modal-footer-actions">
          <button type="button" className="app-modal-close-btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className="app-modal-primary-btn app-modal-danger-btn"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {loading ? "Updating…" : "Set Quantity to 0"}
          </button>
        </div>
      </div>
    </div>
  )
}

function ApproveZeroModal({
  item,
  storeCode,
  onClose,
  onSuccess,
}: {
  item: AppStockAlertItem
  storeCode: string
  onClose: () => void
  onSuccess: () => Promise<void>
}) {
  const router = useRouter()
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [confirmationText, setConfirmationText] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit =
    confirmChecked && confirmationText.trim().toUpperCase() === "ZERO" && !loading

  async function handleApproveZero() {
    if (!canSubmit) return
    setLoading(true)
    setError(null)

    const result = await approveZeroAppStockAlert({
      storeCode,
      alertId: item.alertId,
      confirm: true,
      confirmationText: "ZERO",
    })

    setLoading(false)

    if (!result.ok) {
      if (handleAuthRedirect(router, result.status, result.approvalStatus)) return
      setError(safeApiError(result.error, "Could not set quantity to 0."))
      return
    }

    await onSuccess()
  }

  return (
    <div className="app-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="app-modal"
        role="dialog"
        aria-labelledby="approve-zero-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="approve-zero-title" className="app-modal-title">
              Set eBay quantity to 0?
            </h2>
            <p className="app-modal-subtitle">
              This will update your eBay listing quantity to 0. Buyers will not be able to purchase
              this listing while quantity is 0.
            </p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="app-modal-meta">
          {dash(item.listingTitle)} · ASIN {dash(item.asin)} · Alert #{item.alertId}
        </p>

        <p className="app-modal-warning">
          This action writes to eBay. Use it only when the source product is unavailable, removed,
          or unsafe to fulfill.
        </p>

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-apply-section">
          <h3 className="app-modal-apply-title">Confirm quantity zero</h3>
          <label className="app-modal-apply-label" htmlFor="approve-zero-confirm-text">
            Type ZERO to confirm.
          </label>
          <input
            id="approve-zero-confirm-text"
            type="text"
            value={confirmationText}
            disabled={loading}
            onChange={e => setConfirmationText(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="app-modal-apply-input"
          />
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            I understand this will update my eBay listing quantity.
          </label>
        </div>

        <div className="app-modal-footer app-modal-footer-actions">
          <button type="button" className="app-modal-close-btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className="app-modal-primary-btn app-modal-danger-btn"
            disabled={!canSubmit}
            onClick={() => void handleApproveZero()}
          >
            {loading ? "Updating…" : "Set Quantity to 0"}
          </button>
        </div>
      </div>
    </div>
  )
}

function Qty1Modal({
  item,
  storeCode,
  onClose,
  onSuccess,
}: {
  item: AppStockAlertItem
  storeCode: string
  onClose: () => void
  onSuccess: () => Promise<void>
}) {
  const router = useRouter()
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    if (!confirmChecked || loading) return
    setLoading(true)
    setError(null)

    const qtyResult = await setAppListingQuantity({
      storeCode,
      catalogStateId: item.catalogStateId,
      quantity: 1,
      confirm: true,
    })

    if (!qtyResult.ok) {
      setLoading(false)
      if (handleAuthRedirect(router, qtyResult.status, qtyResult.approvalStatus)) return
      setError(safeApiError(qtyResult.error, "Could not set quantity to 1."))
      return
    }

    if (item.alertId > 0 && canIgnoreAlert(item)) {
      await ignoreAppStockAlert({
        storeCode,
        alertId: item.alertId,
        confirm: true,
      })
    }

    setLoading(false)
    await onSuccess()
  }

  return (
    <div className="app-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="app-modal"
        role="dialog"
        aria-labelledby="qty1-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="qty1-title" className="app-modal-title">
              Set eBay quantity to 1?
            </h2>
            <p className="app-modal-subtitle">
              This will update your eBay listing quantity to 1 and resolve this alert if the update
              succeeds.
            </p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="app-modal-meta">
          {dash(item.listingTitle)} · ASIN {dash(item.asin)} · Alert #{item.alertId}
        </p>

        <p className="app-modal-warning">This action writes to eBay.</p>

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-apply-section">
          <h3 className="app-modal-apply-title">Confirm quantity 1</h3>
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            I understand this will update my eBay listing quantity to 1.
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
            {loading ? "Updating…" : "Set Quantity to 1"}
          </button>
        </div>
      </div>
    </div>
  )
}

function StopTrackingModal({
  item,
  storeCode,
  onClose,
  onSuccess,
}: {
  item: AppStockAlertItem
  storeCode: string
  onClose: () => void
  onSuccess: () => Promise<void>
}) {
  const router = useRouter()
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    if (!confirmChecked || loading) return
    setLoading(true)
    setError(null)

    const guardResult = await updateAppListingStockGuard({
      storeCode,
      catalogStateId: item.catalogStateId,
      enabled: false,
      confirm: true,
    })

    if (!guardResult.ok) {
      setLoading(false)
      if (handleAuthRedirect(router, guardResult.status, guardResult.approvalStatus)) return
      setError(safeApiError(guardResult.error, "Could not stop tracking this listing."))
      return
    }

    if (item.alertId > 0 && canIgnoreAlert(item)) {
      await ignoreAppStockAlert({
        storeCode,
        alertId: item.alertId,
        confirm: true,
      })
    }

    setLoading(false)
    await onSuccess()
  }

  return (
    <div className="app-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="app-modal"
        role="dialog"
        aria-labelledby="stop-tracking-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="stop-tracking-title" className="app-modal-title">
              Stop tracking this listing?
            </h2>
            <p className="app-modal-subtitle">
              Stock Guard will stop monitoring this listing. The alert will be marked ignored after
              tracking is disabled.
            </p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="app-modal-meta">
          {dash(item.listingTitle)} · ASIN {dash(item.asin)} · Alert #{item.alertId}
        </p>

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-apply-section">
          <h3 className="app-modal-apply-title">Confirm stop tracking</h3>
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            I understand Stock Guard will stop monitoring this listing.
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
            {loading ? "Updating…" : "Stop Tracking"}
          </button>
        </div>
      </div>
    </div>
  )
}

function UpdatePriceModal({
  item,
  storeCode,
  onClose,
  onSuccess,
}: {
  item: AppStockAlertItem
  storeCode: string
  onClose: () => void
  onSuccess: () => Promise<void>
}) {
  const router = useRouter()
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pricingLine = pricingContextLine(item)

  async function handleSubmit() {
    if (!confirmChecked || loading) return
    setLoading(true)
    setError(null)

    const result = await updateAppListingPrice({
      storeCode,
      catalogStateId: item.catalogStateId,
      confirm: true,
    })

    setLoading(false)

    if (!result.ok) {
      if (handleAuthRedirect(router, result.status, result.approvalStatus)) return
      setError(safeApiError(result.error, "Could not update listing price."))
      return
    }

    await onSuccess()
  }

  return (
    <div className="app-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="app-modal"
        role="dialog"
        aria-labelledby="update-price-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="update-price-title" className="app-modal-title">
              Update eBay price?
            </h2>
            <p className="app-modal-subtitle">
              Applies the recommended price based on the current source price and your markup
              settings.
            </p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="app-modal-meta">
          {dash(item.listingTitle)} · ASIN {dash(item.asin)} · Alert #{item.alertId}
        </p>
        {pricingLine && <p className="app-modal-meta">Source: {pricingLine}</p>}
        <p className="app-modal-meta">Current eBay: {fmtPrice(item.ebayPrice ?? item.currentDbPrice)}</p>

        <p className="app-modal-warning">This action writes to eBay.</p>

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-apply-section">
          <h3 className="app-modal-apply-title">Confirm price update</h3>
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            I understand this will update my eBay listing price.
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
            {loading ? "Updating…" : "Update Price"}
          </button>
        </div>
      </div>
    </div>
  )
}

function UpdateAsinModal({
  item,
  storeCode,
  onClose,
  onSuccess,
}: {
  item: AppStockAlertItem
  storeCode: string
  onClose: () => void
  onSuccess: () => Promise<void>
}) {
  const router = useRouter()
  const [newAsin, setNewAsin] = useState("")
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const normalizedNew = normalizeAsinInput(newAsin)
  const asinValid = ASIN_INPUT_RE.test(normalizedNew)
  const canSubmit = confirmChecked && asinValid && !loading

  async function handleSubmit() {
    if (!canSubmit) return
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
      if (handleAuthRedirect(router, result.status, result.approvalStatus)) return
      setError(safeApiError(result.error, "Could not update source ASIN."))
      return
    }

    await onSuccess()
  }

  return (
    <div className="app-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="app-modal"
        role="dialog"
        aria-labelledby="update-asin-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="update-asin-title" className="app-modal-title">
              Update source ASIN
            </h2>
            <p className="app-modal-subtitle">
              Link or correct the Amazon ASIN used for source checks on this listing.
            </p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="app-modal-meta">
          {dash(item.listingTitle)} · Current ASIN {dash(item.asin)} · Alert #{item.alertId}
        </p>

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-apply-section">
          <h3 className="app-modal-apply-title">New ASIN</h3>
          <label className="app-modal-apply-label" htmlFor="update-asin-input">
            Enter a 10-character ASIN
          </label>
          <input
            id="update-asin-input"
            type="text"
            value={newAsin}
            disabled={loading}
            onChange={e => setNewAsin(e.target.value.toUpperCase())}
            autoComplete="off"
            spellCheck={false}
            maxLength={10}
            className="app-modal-apply-input"
            placeholder="B0XXXXXXXX"
          />
          {newAsin.trim() && !asinValid && (
            <p className="app-modal-meta" style={{ color: "#e88" }}>
              ASIN must be exactly 10 letters or digits.
            </p>
          )}
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            I understand this will change the source ASIN for this listing.
          </label>
        </div>

        <div className="app-modal-footer app-modal-footer-actions">
          <button type="button" className="app-modal-close-btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className="app-modal-primary-btn"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {loading ? "Saving…" : "Update ASIN"}
          </button>
        </div>
      </div>
    </div>
  )
}

function BulkQty1AlertsModal({
  storeCode,
  selectedItems,
  eligibleCount,
  onClose,
  onSuccess,
}: {
  storeCode:     string
  selectedItems: AppStockAlertItem[]
  eligibleCount: number
  onClose:       () => void
  onSuccess:     () => Promise<void>
}) {
  const router = useRouter()
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AppBulkSetListingQuantityResponse | null>(null)

  const selectedCount = selectedItems.length
  const skippedCount = Math.max(0, selectedCount - eligibleCount)
  const overLimit = eligibleCount > BULK_QTY1_MAX

  const eligibleItems = useMemo(
    () => selectedItems.filter(isBulkQty1Eligible).slice(0, BULK_QTY1_MAX),
    [selectedItems]
  )

  const catalogStateIdsToSend = useMemo(
    () => eligibleItems.map(item => item.catalogStateId),
    [eligibleItems]
  )

  async function handleSubmit() {
    if (!confirmChecked || loading || eligibleCount === 0 || overLimit) return
    setLoading(true)
    setError(null)

    try {
      const apiResult = await bulkSetAppListingQuantity({
        storeCode,
        catalogStateIds: catalogStateIdsToSend,
        quantity: 1,
        confirm: true,
      })

      if (!apiResult.ok) {
        if (handleAuthRedirect(router, apiResult.status, apiResult.approvalStatus)) return
        setError(safeApiError(apiResult.error, "Could not set selected listings quantity to 1."))
        return
      }

      const succeededIds = new Set(
        apiResult.data.results.filter(r => r.outcome === "succeeded").map(r => r.catalogStateId)
      )
      const alertIdsToIgnore = eligibleItems
        .filter(item => succeededIds.has(item.catalogStateId) && isBulkIgnoreEligible(item))
        .map(item => item.alertId)

      if (alertIdsToIgnore.length > 0) {
        try {
          await bulkIgnoreAppStockAlerts({
            storeCode,
            alertIds: alertIdsToIgnore.slice(0, BULK_IGNORE_MAX),
            confirm: true,
          })
        } catch {
          // Quantity mutation succeeded; an ignore/refresh problem must not hide its result.
          setError("Quantity update completed, but some alerts could not be hidden.")
        }
      }

      setResult(apiResult.data)
    } catch (e) {
      setError(safeApiError(e instanceof Error ? e.message : null, "Bulk quantity request failed."))
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
          aria-labelledby="bulk-qty1-result-title"
          onClick={e => e.stopPropagation()}
        >
          <div className="app-modal-header">
            <div>
              <h2 id="bulk-qty1-result-title" className="app-modal-title">
                Bulk quantity 1 complete
              </h2>
              <p className="app-modal-subtitle">
                Eligible listings were updated. Successful alerts were marked ignored when possible.
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
            <li>Uncertain: {result.uncertain}</li>
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
                  Listing #{item.catalogStateId}: {item.error ?? "Could not process."}
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
        aria-labelledby="bulk-qty1-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="bulk-qty1-title" className="app-modal-title">
              Set selected listings quantity to 1?
            </h2>
            <p className="app-modal-subtitle">
              This will update eBay quantity to 1 for eligible selected alerts and resolve those
              alerts when the update succeeds.
            </p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="app-modal-warning">This action writes to eBay.</p>

        <ul className="app-modal-summary-list">
          <li>Selected: {selectedCount}</li>
          <li>Eligible: {eligibleCount}</li>
          <li>Will be skipped: {skippedCount}</li>
          <li>Max allowed per batch: {BULK_QTY1_MAX}</li>
        </ul>

        {overLimit && (
          <p className="app-modal-warning">
            Select at most {BULK_QTY1_MAX} eligible alerts per batch.
          </p>
        )}

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-apply-section">
          <h3 className="app-modal-apply-title">Confirm quantity 1</h3>
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            I understand this will update eBay listing quantities to 1.
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
            {loading ? "Updating…" : "Set Quantity to 1"}
          </button>
        </div>
      </div>
    </div>
  )
}

function BulkStopTrackingModal({
  storeCode,
  selectedItems,
  eligibleCount,
  onClose,
  onSuccess,
}: {
  storeCode:     string
  selectedItems: AppStockAlertItem[]
  eligibleCount: number
  onClose:       () => void
  onSuccess:     () => Promise<void>
}) {
  const router = useRouter()
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AppBulkListingStockGuardResponse | null>(null)

  const selectedCount = selectedItems.length
  const skippedCount = Math.max(0, selectedCount - eligibleCount)
  const overLimit = eligibleCount > BULK_STOP_TRACKING_MAX

  const eligibleItems = useMemo(
    () => selectedItems.filter(isBulkStopTrackingEligible).slice(0, BULK_STOP_TRACKING_MAX),
    [selectedItems]
  )

  const catalogStateIdsToSend = useMemo(
    () => eligibleItems.map(item => item.catalogStateId),
    [eligibleItems]
  )

  async function handleSubmit() {
    if (!confirmChecked || loading || eligibleCount === 0 || overLimit) return
    setLoading(true)
    setError(null)

    const apiResult = await bulkUpdateAppListingStockGuard({
      storeCode,
      catalogStateIds: catalogStateIdsToSend,
      enabled: false,
      confirm: true,
    })

    if (!apiResult.ok) {
      setLoading(false)
      if (handleAuthRedirect(router, apiResult.status, apiResult.approvalStatus)) return
      setError(safeApiError(apiResult.error, "Could not stop tracking selected listings."))
      return
    }

    const succeededIds = new Set(
      apiResult.data.results.filter(r => r.ok).map(r => r.catalogStateId)
    )
    const alertIdsToIgnore = eligibleItems
      .filter(item => succeededIds.has(item.catalogStateId) && isBulkIgnoreEligible(item))
      .map(item => item.alertId)

    if (alertIdsToIgnore.length > 0) {
      await bulkIgnoreAppStockAlerts({
        storeCode,
        alertIds: alertIdsToIgnore.slice(0, BULK_IGNORE_MAX),
        confirm: true,
      })
    }

    setLoading(false)
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
          aria-labelledby="bulk-stop-tracking-result-title"
          onClick={e => e.stopPropagation()}
        >
          <div className="app-modal-header">
            <div>
              <h2 id="bulk-stop-tracking-result-title" className="app-modal-title">
                Bulk stop tracking complete
              </h2>
              <p className="app-modal-subtitle">
                Stock Guard was disabled for eligible listings. Successful alerts were marked ignored
                when possible.
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
                  Listing #{item.catalogStateId}: {item.error ?? "Could not process."}
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
        aria-labelledby="bulk-stop-tracking-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="bulk-stop-tracking-title" className="app-modal-title">
              Stop tracking selected listings?
            </h2>
            <p className="app-modal-subtitle">
              Stock Guard will stop monitoring eligible selected listings. Related alerts will be
              marked ignored when disable succeeds.
            </p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <ul className="app-modal-summary-list">
          <li>Selected: {selectedCount}</li>
          <li>Eligible: {eligibleCount}</li>
          <li>Will be skipped: {skippedCount}</li>
          <li>Max allowed per batch: {BULK_STOP_TRACKING_MAX}</li>
        </ul>

        {overLimit && (
          <p className="app-modal-warning">
            Select at most {BULK_STOP_TRACKING_MAX} eligible alerts per batch.
          </p>
        )}

        {error && <div className="app-modal-error">{error}</div>}

        <div className="app-modal-apply-section">
          <h3 className="app-modal-apply-title">Confirm stop tracking</h3>
          <label className="app-modal-apply-checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              disabled={loading}
              onChange={e => setConfirmChecked(e.target.checked)}
            />
            I understand Stock Guard will stop monitoring these listings.
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
            {loading ? "Updating…" : "Stop Tracking Selected"}
          </button>
        </div>
      </div>
    </div>
  )
}

const VARIANT_COLORS: Record<SourceStatusMeta["variant"], { bg: string; color: string }> = {
  danger:  { bg: "rgba(239, 68, 68, 0.15)",  color: "#f87171" },
  warn:    { bg: "rgba(234, 179, 8, 0.15)",  color: "#ca8" },
  dim:     { bg: "rgba(148, 163, 184, 0.15)", color: "var(--dim)" },
  purple:  { bg: "rgba(168, 85, 247, 0.15)", color: "#c084fc" },
  neutral: { bg: "rgba(107, 114, 128, 0.2)", color: "#9ca3af" },
}

const selectStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "inherit",
  fontSize: 13,
}

const searchInputStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "inherit",
  fontSize: 13,
  minWidth: 180,
  maxWidth: 260,
}

const toolbarBtnStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 13,
}

const toolbarLinkStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  textDecoration: "none",
  fontSize: 13,
}

const monoLinkStyle: CSSProperties = {
  color: "var(--accent, #60a5fa)",
  textDecoration: "none",
  borderBottom: "1px solid transparent",
}

const detailToggleStyle: CSSProperties = {
  marginTop: 4,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--dim)",
  fontSize: 11,
  cursor: "pointer",
  textDecoration: "underline",
}

const actionBtnStyle: CSSProperties = {
  fontSize: 11,
  color: "inherit",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "3px 7px",
  cursor: "pointer",
  whiteSpace: "nowrap",
}

const actionDangerBtnStyle: CSSProperties = {
  ...actionBtnStyle,
  color: "#f87171",
  background: "rgba(239, 68, 68, 0.08)",
  border: "1px solid rgba(239, 68, 68, 0.35)",
}

const actionAccentBtnStyle: CSSProperties = {
  ...actionBtnStyle,
  color: "var(--accent, #60a5fa)",
  border: "1px solid rgba(96, 165, 250, 0.35)",
}

const errorBoxStyle: CSSProperties = {
  padding: 16,
  marginBottom: 16,
  borderRadius: 8,
  border: "1px solid #c44",
  background: "rgba(200,60,60,0.08)",
  color: "#e88",
}

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
}

const thStyle: CSSProperties = {
  padding: "8px 10px",
  fontWeight: 600,
  whiteSpace: "nowrap",
  fontSize: 12,
  color: "var(--dim)",
}

const checkboxThStyle: CSSProperties = {
  ...thStyle,
  width: 40,
  padding: "8px 6px",
}

const checkboxTdStyle: CSSProperties = {
  padding: "8px 6px",
  borderTop: "1px solid var(--border)",
  verticalAlign: "middle",
}

const tdStyle: CSSProperties = {
  padding: "8px 10px",
  borderTop: "1px solid var(--border)",
  verticalAlign: "top",
}

const paginationStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  fontSize: 13,
  color: "var(--dim)",
}

const pageBtnStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
}
