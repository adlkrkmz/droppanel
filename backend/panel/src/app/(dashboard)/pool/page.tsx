"use client"

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import {
  createScheduledPublishCommand,
  deletePoolItems,
  deleteSelectedPoolItems,
  fetchPoolCategoryPreferences,
  fetchScheduledPublishCommand,
  getPool,
  getStores,
  restorePoolItems,
  savePoolCategoryPreferences,
  type PoolCategoryPreferences,
} from "@/lib/api"
import type {
  PoolDispatchResponse,
  PoolPublishResponse,
  PoolRow,
  PoolResult,
  PoolSkipDetail,
  PoolView,
  ScheduleJobProgress,
  StoreRow,
  TitleMode,
} from "@/lib/api"
import { useStore } from "@/lib/storeContext"
import { useToast } from "@/lib/toastContext"
import { addNotification } from "@/lib/notifications"
import ScheduledPublishPanel from "@/components/pool/ScheduledPublishPanel"

const LIVE_SCHEDULE_MIN_INTERVAL_SEC = 30

function toLiveIntervalSeconds(delaySec: number): number {
  return Math.max(LIVE_SCHEDULE_MIN_INTERVAL_SEC, delaySec || LIVE_SCHEDULE_MIN_INTERVAL_SEC)
}

function formatJobProgress(commandId: number, p?: ScheduleJobProgress): string {
  if (!p) return `Job #${commandId} backend işliyor...`
  const done = p.published + p.failed + p.skipped + p.cancelled
  return `Job #${commandId}: ${p.published} listed · ${p.failed} failed · ${p.skipped} skipped · ${done}/${p.total}`
}

function isAllSkippedNoPublish(p?: ScheduleJobProgress): boolean {
  if (!p || p.total === 0) return false
  return p.published === 0 && p.failed === 0 && p.skipped >= p.total
}

const POOL_VIEWS: { id: string; label: string }[] = [
  { id: "active",     label: "Active Pool" },
  { id: "ready",      label: "Ready" },
  { id: "processing", label: "Processing" },
  { id: "assigned",   label: "Assigned" },
  { id: "failed",     label: "Failed / Skipped" },
  { id: "history",    label: "Published History" },
  { id: "archived",   label: "Archived" },
  { id: "all",        label: "All" },
]

const STAGES   = ["all", "validated", "scraped", "ai_generated", "listed"]
const STATUSES = ["all", "ready", "processing", "skipped", "completed"]

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "https://api.listjetgo.com"

const CATEGORY_OPTIONS = [
  "Home & Kitchen",
  "Patio, Lawn & Garden",
  "Beauty & Personal Care",
  "Health & Household",
  "Tools & Home Improvement",
  "Office Products",
  "Pet Supplies",
  "Baby",
  "Sports & Outdoors",
  "Toys & Games",
  "Automotive",
  "Electronics Accessories",
] as const

function amazonUrl(asin: string): string {
  return `https://www.amazon.com/dp/${asin}`
}

function fmtPoolDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  return iso.slice(0, 16).replace("T", " ")
}

function stageColor(s: string): string {
  switch (s) {
    case "validated":    return "var(--info)"
    case "scraped":      return "var(--warn)"
    case "ai_generated": return "var(--accent)"
    case "listed":       return "#b4ff6a"
    default:             return "var(--dim)"
  }
}

function statusColor(s: string): string {
  if (s === "success" || s === "ready")     return "var(--accent)"
  if (s === "failed"  || s === "error")     return "var(--danger)"
  if (s === "pending" || s === "completed") return "var(--sub)"
  return "var(--dim)"
}

function Dot({ color }: { color: string }) {
  return <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />
}

function Badge({ value, color }: { value: string; color: string }) {
  return (
    <span style={{ padding: "1px 7px", borderRadius: "20px", fontSize: "10px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", background: color + "22", color }}>
      {value}
    </span>
  )
}

function poolStoreDisplayName(
  stores: StoreRow[],
  code: string | null | undefined,
  assignedName?: string | null
): string {
  const fromRow = assignedName?.trim()
  if (fromRow) return fromRow
  if (code == null || String(code).trim() === "") return "—"
  const row = stores.find((s) => s.storeCode === code)
  return row?.name?.trim() || "—"
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ padding: "12px 16px", background: "var(--surface)", border: "1px solid var(--border)", borderTop: `2px solid ${color}`, borderRadius: "3px" }}>
      <p style={{ fontSize: "10px", letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>{label}</p>
      <p style={{ fontSize: "24px", fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace", marginTop: "4px" }}>{value}</p>
    </div>
  )
}

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        border: `2px solid rgba(255,255,255,0.35)`,
        borderTopColor: "var(--accent)",
        animation: "dp-spin 0.8s linear infinite",
      }}
    />
  )
}

async function postAdmin<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`API ${res.status} ${res.statusText}: ${text ? text : ""}`.trim())
  }
  return res.json() as Promise<T>
}

const POOL_SKIP_REASON_LABELS: Record<string, string> = {
  POOL_ITEM_ARCHIVED:        "Archived",
  POOL_ITEM_ALREADY_LISTED:  "Already listed",
  POOL_ITEM_COMPLETED:       "Completed",
  POOL_ITEM_SUCCESS:         "Already published",
  POOL_ITEM_NOT_FOUND:       "Pool item could not be resolved. Job creation bug or item removed.",
  POOL_ITEM_MISSING_OR_DELETED: "Pool row missing (possible legacy physical delete).",
  POOL_ITEM_ARCHIVED_NOT_ELIGIBLE: "Archived — not eligible for publish.",
  NOT_PRIME:                 "Ürün Prime değil. Listeleme durduruldu.",
  OUT_OF_STOCK:              "Out of stock on Amazon.",
  LIMITED_STOCK:             "Amazon’da sınırlı stok tespit edildi. Ürün listelenmedi.",
  NO_VALID_PRICE:            "No valid Amazon price.",
  NEEDS_AMAZON_VALIDATION:   "Prime/stock check required — run extension extract.",
  PRIME_UNKNOWN:             "Prime doğrulanamadı. Yalnızca seçili Amazon teklifinde açık Prime kanıtı bulunan ürünler listelenebilir.",
  STOCK_UNKNOWN:             "Stok durumu doğrulanamadı. Ürün listelenmedi.",
  POOL_ITEM_NOT_ELIGIBLE:    "Not eligible",
  STORE_CONFLICT:            "Store conflict",
  NOT_READY:                 "Not ready",
  POOL_ITEM_ALREADY_QUEUED:  "Already queued",
}

function poolSkipReasonLabel(reason: string): string {
  return POOL_SKIP_REASON_LABELS[reason] ?? reason
}

function mergePoolSkipDetails(...sources: Array<PoolSkipDetail[] | undefined | null>): PoolSkipDetail[] {
  const seen = new Set<string>()
  const out: PoolSkipDetail[] = []
  for (const list of sources) {
    if (!list) continue
    for (const d of list) {
      const key = `${d.poolId ?? ""}:${d.reason}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(d)
    }
  }
  return out
}

function PoolSkipWarningBanner({ details }: { details: PoolSkipDetail[] }) {
  if (details.length === 0) return null
  const shown = details.slice(0, 5)
  const more = details.length - shown.length
  return (
    <div
      style={{
        padding: "10px 16px",
        marginBottom: "16px",
        background: "rgba(255,193,7,0.06)",
        border: "1px solid rgba(255,193,7,0.25)",
        borderRadius: "3px",
        fontSize: "12px",
        fontFamily: "'JetBrains Mono', monospace",
        color: "var(--warn)",
      }}
    >
      <p style={{ marginBottom: "8px", fontWeight: 700 }}>
        {details.length} selected ASIN{details.length !== 1 ? "s were" : " was"} skipped because they are archived or already listed.
      </p>
      {shown.map((d) => (
        <div key={`${d.poolId ?? "x"}-${d.reason}`} style={{ color: "var(--sub)", marginBottom: "2px" }}>
          {d.asin ?? `Pool #${d.poolId ?? "?"}`} · {poolSkipReasonLabel(d.reason)}
        </div>
      ))}
      {more > 0 && <div style={{ color: "var(--dim)", marginTop: "4px" }}>+{more} more skipped</div>}
    </div>
  )
}

const filterBtn = (active: boolean): React.CSSProperties => ({
  padding: "5px 12px", border: "1px solid var(--border)", borderRadius: "3px", cursor: "pointer",
  fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", fontWeight: 600,
  textTransform: "uppercase", letterSpacing: "0.5px",
  background:   active ? "rgba(0,255,136,0.1)" : "var(--surface)",
  color:        active ? "var(--accent)"        : "var(--sub)",
  borderColor:  active ? "rgba(0,255,136,0.3)"  : "var(--border)",
  transition: "all 0.15s",
})

export default function PoolPage() {
  const POOL_PAGE_SIZE = 50
  const { selectedStore, setSelectedStore } = useStore()
  const { showToast } = useToast()
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [categoryPrefs, setCategoryPrefs] = useState<PoolCategoryPreferences>({ categories: [], note: "" })
  const [categoryLoading, setCategoryLoading] = useState(true)
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [categorySaving, setCategorySaving] = useState(false)
  const [categorySaveStatus, setCategorySaveStatus] = useState<string | null>(null)
  const [data,    setData]    = useState<PoolResult | null>(null)
  const [stores,  setStores]  = useState<StoreRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const [poolView,     setPoolView]     = useState("active")
  const [stageFilter,  setStageFilter]  = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [storeFilter,  setStoreFilter]  = useState("all")

  const [publishLoadingByPoolId, setPublishLoadingByPoolId] = useState<Record<number, boolean>>({})
  const [publishStoreByPoolId, setPublishStoreByPoolId] = useState<Record<number, string>>({})
  const [selectedPoolIds, setSelectedPoolIds] = useState<Set<number>>(new Set())
  const [publishQuantityByPoolId, setPublishQuantityByPoolId] = useState<Record<number, number>>({})
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [restoreLoading, setRestoreLoading] = useState(false)
  const [poolSkipWarning, setPoolSkipWarning] = useState<PoolSkipDetail[] | null>(null)
  const poolSkipWarningTimerRef = useRef<number | null>(null)

  const selectedStoreDisplayLabel = useMemo(
    () => stores.find((s) => s.storeCode === selectedStore)?.name?.trim() || "Store",
    [stores, selectedStore]
  )

  // ─── Dispatch Selected (new) ───────────────────────────────
  const [dispatchModalOpen, setDispatchModalOpen] = useState(false)
  const [dispatchQuantity, setDispatchQuantity] = useState(1)
  const [dispatchDelay, setDispatchDelay] = useState(30)
  const [dispatchLoading, setDispatchLoading] = useState(false)
  const [dispatchResult, setDispatchResult] = useState<string | null>(null)
  const dispatchResultTimerRef = useRef<number | null>(null)

  // ─── Quick Dispatch (new) ────────────────────────────────
  const [quickDispatchCount, setQuickDispatchCount] = useState<number>(10)
  const [quickDispatchQuantity, setQuickDispatchQuantity] = useState<number>(1)
  const [quickDispatchDelay, setQuickDispatchDelay] = useState<number>(30)
  const [quickDispatchLoading, setQuickDispatchLoading] = useState<boolean>(false)
  const [quickDispatchMessage, setQuickDispatchMessage] = useState<string | null>(null)
  const quickDispatchMessageTimerRef = useRef<number | null>(null)
  const quickPollRef = useRef<number | null>(null)
  const dispatchPollRef = useRef<number | null>(null)
  const [poolPage, setPoolPage] = useState(1)
  const [titleMode, setTitleMode] = useState<TitleMode>("ai")

  const headerCheckboxRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [poolData, storeData] = await Promise.all([
        getPool({
          view:      showAdvanced ? (poolView as PoolView) : "active",
          stage:     showAdvanced && stageFilter  !== "all" ? stageFilter  : undefined,
          status:    showAdvanced && statusFilter !== "all" ? statusFilter : undefined,
          storeCode: showAdvanced && storeFilter  !== "all" ? storeFilter  : undefined,
          limit: 100000,
        }),
        getStores(),
      ])
      setData(poolData); setStores(storeData.rows)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [showAdvanced, poolView, stageFilter, statusFilter, storeFilter])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    setShowAdvanced(new URLSearchParams(window.location.search).get("advanced") === "1")
  }, [])

  useEffect(() => {
    let cancelled = false
    setCategoryLoading(true)
    setCategoryError(null)
    void fetchPoolCategoryPreferences()
      .then((prefs) => {
        if (!cancelled) setCategoryPrefs(prefs)
      })
      .catch((e) => {
        if (!cancelled) {
          setCategoryError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setCategoryLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // Polling interval'larını unmount'ta temizle
  useEffect(() => {
    return () => {
      if (quickPollRef.current)   clearInterval(quickPollRef.current)
      if (dispatchPollRef.current) clearInterval(dispatchPollRef.current)
    }
  }, [])

  useEffect(() => {
    if (!dispatchResult) return

    if (dispatchResultTimerRef.current != null) window.clearTimeout(dispatchResultTimerRef.current)
    dispatchResultTimerRef.current = window.setTimeout(() => setDispatchResult(null), 4000)

    return () => {
      if (dispatchResultTimerRef.current != null) window.clearTimeout(dispatchResultTimerRef.current)
    }
  }, [dispatchResult])

  useEffect(() => {
    if (!poolSkipWarning) return
    if (poolSkipWarningTimerRef.current != null) window.clearTimeout(poolSkipWarningTimerRef.current)
    poolSkipWarningTimerRef.current = window.setTimeout(() => setPoolSkipWarning(null), 12000)
    return () => {
      if (poolSkipWarningTimerRef.current != null) window.clearTimeout(poolSkipWarningTimerRef.current)
    }
  }, [poolSkipWarning])

  useEffect(() => {
    if (!quickDispatchMessage) return
    if (quickDispatchMessageTimerRef.current != null) window.clearTimeout(quickDispatchMessageTimerRef.current)
    quickDispatchMessageTimerRef.current = window.setTimeout(() => setQuickDispatchMessage(null), 3000)
    return () => {
      if (quickDispatchMessageTimerRef.current != null) window.clearTimeout(quickDispatchMessageTimerRef.current)
    }
  }, [quickDispatchMessage])

  useEffect(() => {
    if (!dispatchModalOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDispatchModalOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [dispatchModalOpen])

  const rows         = data?.rows ?? []

  const showRestoreSelected = useMemo(() => {
    if (poolView === "archived") return true
    if (poolView === "all" && selectedPoolIds.size > 0) {
      const rowMap = new Map(rows.map((r) => [r.poolId, r]))
      return [...selectedPoolIds].some((id) => !!rowMap.get(id)?.archivedAt)
    }
    return false
  }, [poolView, selectedPoolIds, rows])

  const showPoolSkips = useCallback((...sources: Array<PoolSkipDetail[] | undefined | null>) => {
    const merged = mergePoolSkipDetails(...sources)
    if (merged.length > 0) setPoolSkipWarning(merged)
  }, [])
  const totalPages = Math.max(1, Math.ceil(rows.length / POOL_PAGE_SIZE))
  const pagedRows = rows.slice((poolPage - 1) * POOL_PAGE_SIZE, poolPage * POOL_PAGE_SIZE)
  const totalCount   = data?.total ?? 0
  const readyCount   = rows.filter(r => r.status === "ready").length
  const aiCount      = rows.filter(r => r.pipelineStage === "ai_generated").length
  const assignedCount = rows.filter(r => r.assignedStoreId !== null).length

  const visiblePoolIds = rows.map(r => r.poolId)
  const visibleSelectedCount = visiblePoolIds.reduce((acc, pid) => acc + (selectedPoolIds.has(pid) ? 1 : 0), 0)
  const allVisibleSelected = visiblePoolIds.length > 0 && visibleSelectedCount === visiblePoolIds.length
  const someVisibleSelected = visibleSelectedCount > 0 && visibleSelectedCount < visiblePoolIds.length

  useEffect(() => {
    if (!headerCheckboxRef.current) return
    headerCheckboxRef.current.indeterminate = someVisibleSelected
  }, [someVisibleSelected])

  useEffect(() => {
    if (poolPage > totalPages) setPoolPage(totalPages)
  }, [poolPage, totalPages])

  const updateRow = (poolId: number, patch: Partial<PoolRow>) => {
    setData(prev => {
      if (!prev) return prev
      return {
        ...prev,
        rows: prev.rows.map(r => r.poolId === poolId ? { ...r, ...patch } : r),
      }
    })
  }

  const actionBtn = (kind: "ai" | "publish", disabled: boolean): React.CSSProperties => {
    const base: React.CSSProperties = {
      padding: "4px 10px",
      border: "1px solid var(--border)",
      borderRadius: "3px",
      background: "var(--surface)",
      color: "var(--sub)",
      fontSize: "11px",
      fontFamily: "'JetBrains Mono', monospace",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.7 : 1,
    }
    if (kind === "ai") return { ...base, borderColor: "rgba(0,255,136,0.3)", color: disabled ? "var(--sub)" : "var(--accent)" }
    return { ...base, borderColor: "rgba(0,170,255,0.3)", color: disabled ? "var(--sub)" : "var(--accent)" }
  }

  const handlePublish = async (row: PoolRow) => {
    const pid = row.poolId
    const mode = titleMode
    const quantity = publishQuantityByPoolId[pid] ?? 1
    const selectedStoreCode =
      publishStoreByPoolId[pid] ??
      row.assignedStoreCode ??
      stores[0]?.storeCode ??
      "S1"

    setPublishLoadingByPoolId(prev => ({ ...prev, [pid]: true }))
    setError(null)
    try {
      if (mode === "ai" && row.pipelineStage === "scraped") {
        await postAdmin("/admin/ai-listing/generate", { asin: row.asin })
        updateRow(pid, { aiStatus: "success", pipelineStage: "ai_generated" })
      }

      const dispatchRes = await postAdmin<PoolDispatchResponse>(
        "/admin/pool/dispatch-selected",
        {
          storeCode: selectedStoreCode,
          poolIds: [pid],
          quantity,
          titleMode: mode,
        }
      )

      showPoolSkips(dispatchRes.skipDetails, dispatchRes.poolSkipDetails)

      if (!dispatchRes.selectedCount) {
        const detail = dispatchRes.skipDetails?.[0] ?? dispatchRes.poolSkipDetails?.[0]
        const reason = detail
          ? `${poolSkipReasonLabel(detail.reason)}${detail.asin ? ` (${detail.asin})` : ""}`
          : "ready + scraped/ai_generated olmalı"
        throw new Error(`Ürün mağazaya atanamadı: ${reason}`)
      }

      const runRes = await postAdmin<PoolPublishResponse>(
        "/admin/publish/run",
        {
          storeCode: selectedStoreCode,
          poolIds: dispatchRes.assignedPoolIds.length > 0 ? dispatchRes.assignedPoolIds : [pid],
          limit: 1,
          dryRun: false,
          simulationMode: false,
          quantity,
          titleMode: mode,
        }
      )

      showPoolSkips(runRes.poolSkipDetails)

      const succeeded = runRes?.succeeded ?? 0
      const failed    = runRes?.failed    ?? 0
      const blocked   = runRes?.blocked   ?? 0
      const skipped   = runRes?.skipped   ?? 0

      if (succeeded > 0) {
        updateRow(pid, {
          listingStatus: "success",
          pipelineStage: "listed",
          assignedStoreCode: selectedStoreCode,
        })
        const label =
          mode === "ai" ? "AI title ile yüklendi"
          : mode === "titlebot" ? "TitleBot ile yüklendi"
          : "Amazon title ile yüklendi"
        addNotification("success", "eBay'e Yüklendi", `${row.asin} ${label}.`)
      } else {
        const items = runRes?.items ?? []
        const primeBlocked = items.find((i) => {
          const blob = `${i.error ?? ""} ${(i.guardErrors ?? []).join(" ")}`.toUpperCase()
          return (
            i.status === "blocked" || i.status === "skipped" || i.status === "failed"
          ) && (
            blob.includes("PRIME_UNKNOWN")
            || blob.includes("NOT_PRIME")
            || blob.includes("PRIME")
          )
        })
        const stockBlocked = items.find((i) => {
          const blob = `${i.error ?? ""} ${(i.guardErrors ?? []).join(" ")}`.toUpperCase()
          return (
            i.status === "blocked" || i.status === "skipped" || i.status === "failed"
          ) && (
            blob.includes("LIMITED_STOCK")
            || blob.includes("OUT_OF_STOCK")
            || blob.includes("STOCK_UNKNOWN")
          )
        })
        const skipPrime = runRes?.poolSkipDetails?.find(
          (d) => d.reason === "PRIME_UNKNOWN" || d.reason === "NOT_PRIME"
        )
        const skipStock = runRes?.poolSkipDetails?.find(
          (d) => d.reason === "LIMITED_STOCK" || d.reason === "OUT_OF_STOCK" || d.reason === "STOCK_UNKNOWN"
        )
        let errMsg: string
        if (skipStock?.reason === "LIMITED_STOCK" || (stockBlocked && /LIMITED_STOCK/i.test(stockBlocked.error ?? ""))) {
          const countMatch = (stockBlocked?.error ?? "").match(/Only\s+(\d+)\s+left/i)
          errMsg = countMatch
            ? `Amazon’da sınırlı stok tespit edildi: yalnızca ${countMatch[1]} adet kaldı. Ürün listelenmedi.`
            : "Amazon’da sınırlı stok tespit edildi. Ürün listelenmedi."
        } else if (skipStock?.reason === "OUT_OF_STOCK" || (stockBlocked && /OUT_OF_STOCK/i.test(stockBlocked.error ?? ""))) {
          errMsg = "Out of stock on Amazon."
        } else if (skipStock?.reason === "STOCK_UNKNOWN" || (stockBlocked && /STOCK_UNKNOWN/i.test(stockBlocked.error ?? ""))) {
          errMsg = "Stok durumu doğrulanamadı. Ürün listelenmedi."
        } else if (skipPrime?.reason === "NOT_PRIME" || (primeBlocked && /NOT_PRIME/i.test(primeBlocked.error ?? ""))) {
          errMsg = "Ürün Prime değil. Listeleme durduruldu."
        } else if (
          skipPrime?.reason === "PRIME_UNKNOWN"
          || blocked > 0
          || skipped > 0
          || primeBlocked
        ) {
          errMsg = "Prime doğrulanamadı. Yalnızca seçili Amazon teklifinde açık Prime kanıtı bulunan ürünler listelenebilir."
        } else {
          errMsg = items.find((i) => i.status === "failed" || i.status === "blocked")?.error
            ?? "eBay yükleme başarısız"
        }
        setError(errMsg)
        addNotification("error", `Yüklenemedi: ${row.asin}`, errMsg)
        void failed
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      addNotification("error", `Yüklenemedi: ${row.asin}`, msg)
    } finally {
      setPublishLoadingByPoolId(prev => ({ ...prev, [pid]: false }))
    }
  }

  const handleRestoreSelected = async () => {
    if (selectedPoolIds.size === 0) return
    const ids = Array.from(selectedPoolIds)
    const confirmed = window.confirm(
      "Restore selected ASINs?\n\nRestored ASINs return to the pool only if they are not already listed or completed."
    )
    if (!confirmed) return

    setRestoreLoading(true)
    setError(null)
    try {
      const res = await restorePoolItems(ids)
      setSelectedPoolIds(new Set())
      await load()
      const skipped = res.results?.filter((r) => r.message === "Already active.").length ?? 0
      const msg = skipped > 0
        ? `${res.restored} restored, ${skipped} skipped`
        : `${res.restored} ASINs restored`
      showToast(msg)
      addNotification("info", "Restored", msg)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      showToast(msg, "error")
      addNotification("error", "Restore Error", msg)
    } finally {
      setRestoreLoading(false)
    }
  }

  const handleDeleteSelected = async () => {
    if (selectedPoolIds.size === 0) return
    const ids = Array.from(selectedPoolIds)
    const confirmed = window.confirm(
      "Selected ASINs will be deleted from pool only. eBay listings and My Listings will not be affected. Continue?"
    )
    if (!confirmed) return

    setDeleteLoading(true)
    setError(null)
    try {
      const res = await deleteSelectedPoolItems(ids)
      setSelectedPoolIds(new Set())
      await load()
      const msg = res.skippedCount > 0
        ? `${res.deletedCount} deleted, ${res.skippedCount} skipped (active job)`
        : `${res.deletedCount} ASIN${res.deletedCount === 1 ? "" : "s"} deleted`
      showToast(msg, res.skippedCount > 0 ? "error" : "success")
      addNotification(
        res.skippedCount > 0 ? "error" : "info",
        "Pool delete",
        msg
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      showToast(msg, "error")
      addNotification("error", "Delete Error", msg)
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleArchiveSelected = async () => {
    if (selectedPoolIds.size === 0) return
    const ids = Array.from(selectedPoolIds)
    const confirmed = window.confirm(
      "Archive selected ASINs?\n\nArchived ASINs are hidden from Active Pool but not deleted.\nArchive does not remove listing history or My Listings data."
    )
    if (!confirmed) return

    setArchiveLoading(true)
    setError(null)
    try {
      const res = await deletePoolItems(ids)
      setSelectedPoolIds(new Set())
      await load()
      const msg = `${res.archived} ASIN archived`
      showToast(msg)
      addNotification("info", "Archived", msg)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      showToast(msg, "error")
      addNotification("error", "Archive Error", msg)
    } finally {
      setArchiveLoading(false)
    }
  }

  const pollLiveJobStatus = (
    commandId: number,
    pollRef: React.MutableRefObject<number | null>,
    onMessage: (msg: string) => void,
    onComplete: (msg: string, published: number, failed: number) => void,
  ) => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }

    const POLL_TIMEOUT = 2 * 60 * 60 * 1000
    const startedAt = Date.now()

    pollRef.current = window.setInterval(() => {
      void (async () => {
        try {
          if (Date.now() - startedAt > POLL_TIMEOUT) {
            clearInterval(pollRef.current!); pollRef.current = null
            onMessage(`Job #${commandId} hâlâ çalışıyor — Scheduled Commands bölümünden izleyin`)
            return
          }

          const detail = await fetchScheduledPublishCommand(commandId)
          const cmd = detail.command
          onMessage(formatJobProgress(commandId, cmd.progress))

          if (cmd.status === "completed" || cmd.status === "failed" || cmd.status === "cancelled") {
            clearInterval(pollRef.current!); pollRef.current = null
            const p = cmd.progress
            const published = p?.published ?? 0
            const failed = p?.failed ?? 0
            const skipped = p?.skipped ?? 0
            let msg: string
            if (cmd.status === "completed" && isAllSkippedNoPublish(p)) {
              msg = `✗ Job #${commandId} tamamlandı ama 0 listed — ${skipped} skipped (pool item hatası olabilir)`
            } else if (cmd.status === "completed") {
              msg = `✓ Job #${commandId} tamamlandı — ${published} listed · ${failed} failed · ${skipped} skipped`
            } else {
              msg = `✗ Job #${commandId} ${cmd.status}`
            }
            onComplete(msg, published, failed)
            await load()
          }
        } catch {
          /* transient poll errors — keep polling */
        }
      })()
    }, 5000)
  }

  const handleQuickDispatch = async (): Promise<void> => {
    if (quickDispatchLoading) return

    if (quickPollRef.current) { clearInterval(quickPollRef.current); quickPollRef.current = null }

    setQuickDispatchLoading(true)
    setQuickDispatchMessage(null)

    try {
      const count = Math.max(1, quickDispatchCount)
      const intervalSeconds = toLiveIntervalSeconds(quickDispatchDelay)

      const res = await createScheduledPublishCommand({
        storeCode: selectedStore,
        selectionMode: "ready_next",
        count,
        startAt: new Date().toISOString(),
        intervalSeconds,
        quantity: quickDispatchQuantity,
        titleMode,
        executionMode: "live",
        confirm: true,
        title: "Quick Dispatch",
        evidenceGate: true,
      })

      showPoolSkips(res.skipDetails)

      const eg = res.evidenceGate
      const msgParts: string[] = []
      if (eg?.readyForPublishCount) {
        msgParts.push(`${eg.readyForPublishCount} ürün yayın kuyruğuna alındı`)
      }
      if (eg?.captureRequiredCount) {
        msgParts.push(`${eg.captureRequiredCount} ürün Amazon kontrol kuyruğuna alındı — Extension Chrome açıkken otomatik işleyecek`)
      }
      if (eg?.readyForPublishCount || eg?.captureRequiredCount) {
        msgParts.push("Paneli kapatsanız da backend publish devam eder")
      }
      if (eg?.skippedCount) {
        msgParts.push(`${eg.skippedCount} ürün skip edildi`)
      }

      const summary = msgParts.length > 0 ? msgParts.join(" · ") : (eg?.message ?? "Quick Dispatch tamamlandı")
      setQuickDispatchMessage(summary)
      showToast(summary)
      setQuickDispatchLoading(false)

      if (eg?.captureRequiredCount) {
        addNotification(
          "info",
          "Otomatik Capture",
          `${eg.captureRequiredCount} ürün capture kuyruğunda — Extension Chrome açıkken otomatik veri toplayacak`
        )
      }
      if (eg?.readyForPublishCount) {
        addNotification("success", "Quick Dispatch", `${eg.readyForPublishCount} ürün yayın kuyruğuna alındı`)
      }

      const publishCommandId = eg?.publishCommandId ?? res.command?.id
      if (publishCommandId) {
        pollLiveJobStatus(
          publishCommandId,
          quickPollRef,
          setQuickDispatchMessage,
          (pollMsg, published, failed) => {
            setQuickDispatchMessage(pollMsg)
            showToast(pollMsg)
            if (published > 0) addNotification("success", "Quick Dispatch Tamamlandı", pollMsg)
            if (failed > 0) addNotification("error", "Quick Dispatch: Başarısız", pollMsg)
          },
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setQuickDispatchMessage(`✗ ${msg}`)
      showToast(msg, "error")
      addNotification("error", "Quick Dispatch Hatası", msg)
      setQuickDispatchLoading(false)
    }
  }

  const handleDispatchSelected = async (): Promise<void> => {
    if (selectedPoolIds.size === 0) return

    if (dispatchPollRef.current) { clearInterval(dispatchPollRef.current); dispatchPollRef.current = null }

    setDispatchLoading(true)
    setError(null)

    const poolIds = [...selectedPoolIds]

    try {
      const intervalSeconds = toLiveIntervalSeconds(dispatchDelay)

      const res = await createScheduledPublishCommand({
        storeCode: selectedStore,
        selectionMode: "selected",
        poolIds,
        count: poolIds.length,
        startAt: new Date().toISOString(),
        intervalSeconds,
        quantity: dispatchQuantity,
        titleMode,
        executionMode: "live",
        confirm: true,
        title: "Dispatch Selected",
      })

      showPoolSkips(res.skipDetails)

      if (!res.command) throw new Error("Publish command oluşturulamadı")
      const commandId = res.command.id
      setDispatchResult(`Job #${commandId} oluşturuldu — ${res.command.createdJobCount} ürün backend kuyruğunda`)
      setDispatchModalOpen(false)
      setDispatchLoading(false)

      pollLiveJobStatus(
        commandId,
        dispatchPollRef,
        setDispatchResult,
        (msg, published, failed) => {
          setDispatchResult(msg)
          setSelectedPoolIds(new Set())
          if (published > 0) addNotification("success", "Dispatch Tamamlandı", msg)
          if (failed > 0) addNotification("error", "Dispatch: Başarısız", msg)
        },
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setDispatchResult(`✗ ${msg}`)
      addNotification("error", "Dispatch Hatası", msg)
      setDispatchLoading(false)
    }
  }

  const isDispatchSuccess = dispatchResult?.startsWith("✓") ?? false

  const toggleCategory = (category: string) => {
    setCategoryPrefs((prev) => {
      const has = prev.categories.includes(category)
      return {
        ...prev,
        categories: has ? prev.categories.filter((c) => c !== category) : [...prev.categories, category],
      }
    })
  }

  const saveCategoryPreferences = async () => {
    setCategorySaving(true)
    setCategorySaveStatus(null)
    setCategoryError(null)
    try {
      const saved = await savePoolCategoryPreferences(categoryPrefs)
      setCategoryPrefs(saved)
      setCategorySaveStatus("Preferences saved")
      showToast("Category preferences saved")
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not save preferences"
      setCategoryError(msg)
      showToast(msg, "error")
    } finally {
      setCategorySaving(false)
    }
  }

  return (
    <div style={{ maxWidth: "1100px", animation: "fade-in 0.3s ease forwards" }}>
      <style>{`
        @keyframes dp-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      {poolSkipWarning && poolSkipWarning.length > 0 && (
        <PoolSkipWarningBanner details={poolSkipWarning} />
      )}

      {quickDispatchMessage && (
        <div
          style={{
            padding: "10px 16px",
            marginBottom: "16px",
            background: quickDispatchMessage.startsWith("✓") ? "rgba(0,255,136,0.06)" : "rgba(255,68,85,0.06)",
            border: `1px solid ${quickDispatchMessage.startsWith("✓") ? "rgba(0,255,136,0.2)" : "rgba(255,68,85,0.2)"}`,
            borderRadius: "3px",
            color: quickDispatchMessage.startsWith("✓") ? "var(--accent)" : "var(--danger)",
            fontSize: "12px",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {quickDispatchMessage}
        </div>
      )}

      <p style={{ fontSize: 12, color: "var(--sub)", marginBottom: 20, lineHeight: 1.5 }}>
        Queue listings, schedule batches, and track ASINs waiting in your pool.
      </p>

      {/* Quick Dispatch */}
      <div style={{ padding: "14px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", marginBottom: "20px" }}>
        <div style={{ fontSize: "12px", fontWeight: 900, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", marginBottom: 12 }}>
          Quick Dispatch
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10, alignItems: "end", marginBottom: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace" }}>Store</span>
            <select
              value={selectedStore}
              onChange={(e) => setSelectedStore(e.target.value)}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", padding: "8px 10px", color: "var(--text)", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", width: "100%" }}
            >
              {stores.map((s) => (
                <option key={s.id} value={s.storeCode}>{s.name?.trim() || s.storeCode}</option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace" }}>Title Mode</span>
            <select
              value={titleMode}
              onChange={(e) => setTitleMode(e.target.value as TitleMode)}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", padding: "8px 10px", color: "var(--text)", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", width: "100%" }}
            >
              <option value="ai">AI Title</option>
              <option value="titlebot">Titlebot</option>
              <option value="original">Original Amazon Title</option>
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "0.6fr 0.7fr 0.7fr auto", gap: 10, alignItems: "end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace" }}>
              Count
            </span>
            <input
              type="number"
              min={1}
              max={500}
              value={quickDispatchCount}
              onChange={(e) => setQuickDispatchCount(Math.max(1, parseInt(e.target.value) || 10))}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", padding: "8px 10px", color: "var(--text)", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", width: "100%" }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace" }}>
              Quantity
            </span>
            <input
              type="number"
              min={1}
              max={999}
              value={quickDispatchQuantity}
              onChange={(e) => setQuickDispatchQuantity(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", padding: "8px 10px", color: "var(--text)", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", width: "100%" }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace" }}>
              Delay (s)
            </span>
            <input
              type="number"
              min={30}
              max={3600}
              value={quickDispatchDelay}
              onChange={(e) => setQuickDispatchDelay(Math.max(0, parseInt(e.target.value) || 0))}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", padding: "8px 10px", color: "var(--text)", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", width: "100%" }}
            />
          </div>

          <button
            onClick={() => void handleQuickDispatch()}
            disabled={quickDispatchLoading}
            style={{
              padding: "10px 14px",
              borderRadius: "3px",
              border: "1px solid rgba(0,255,136,0.3)",
              background: "var(--accent)",
              color: "#000",
              fontSize: 11,
              fontFamily: "'JetBrains Mono', monospace",
              cursor: quickDispatchLoading ? "not-allowed" : "pointer",
              opacity: quickDispatchLoading ? 0.7 : 1,
              fontWeight: 900,
              letterSpacing: "0.5px",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}
          >
            ▶ Quick Dispatch
          </button>
        </div>
      </div>

      <ScheduledPublishPanel
        stores={stores}
        scheduleStoreCode={selectedStore}
        onScheduleStoreChange={setSelectedStore}
        selectedPoolIds={selectedPoolIds}
        titleMode={titleMode}
      />

      {error && (
        <div style={{ padding: "10px 16px", marginBottom: "16px", background: "rgba(255,68,85,0.06)", border: "1px solid rgba(255,68,85,0.2)", borderRadius: "3px", color: "var(--danger)", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace" }}>
          {error}
        </div>
      )}

      {dispatchResult && (
        <div style={{
          padding: "10px 16px",
          marginBottom: "16px",
          background: isDispatchSuccess ? "rgba(0,255,136,0.06)" : "rgba(255,68,85,0.06)",
          border: `1px solid ${isDispatchSuccess ? "rgba(0,255,136,0.2)" : "rgba(255,68,85,0.2)"}`,
          borderRadius: "3px",
          color: isDispatchSuccess ? "var(--accent)" : "var(--danger)",
          fontSize: "12px",
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {dispatchResult}
        </div>
      )}

      {/* Summary */}
      <div style={{ display: "grid", gridTemplateColumns: showAdvanced ? "repeat(4, 1fr)" : "1fr", gap: "12px", marginBottom: "20px" }}>
        <StatCard label={showAdvanced ? "Total" : "Total ASINs"} value={totalCount} color="var(--text)" />
        {showAdvanced && (
          <>
            <StatCard label="Ready"        value={readyCount}   color="var(--warn)"   />
            <StatCard label="AI Generated" value={aiCount}      color="var(--accent)" />
            <StatCard label="Assigned"     value={assignedCount} color="var(--info)"  />
          </>
        )}
      </div>

      {/* Filters (advanced) */}
      {showAdvanced && (
      <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", marginBottom: "16px", alignItems: "center" }}>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "1px", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase" }}>Pool View</span>
          {POOL_VIEWS.map(v => (
            <button key={v.id} style={filterBtn(poolView === v.id)} onClick={() => setPoolView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "1px", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase" }}>Stage</span>
          {STAGES.map(s => (
            <button key={s} style={filterBtn(stageFilter === s)} onClick={() => setStageFilter(s)}>
              {s === "all" ? "All" : s.replace("_", " ")}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "1px", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase" }}>Status</span>
          {STATUSES.map(s => (
            <button key={s} style={filterBtn(statusFilter === s)} onClick={() => setStatusFilter(s)}>{s}</button>
          ))}
        </div>

        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "1px", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase" }}>Store</span>
          <select
            id="pool-store-filter"
            value={storeFilter}
            onChange={e => setStoreFilter(e.target.value)}
            style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", padding: "5px 10px", color: "var(--text)", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}
          >
            <option value="all">All Stores</option>
            {stores.map((s) => (
              <option key={s.id} value={s.storeCode}>
                {s.name?.trim() || "Store"}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "center", marginLeft: "auto" }}>
          {showRestoreSelected && (
            <button
              onClick={handleRestoreSelected}
              disabled={selectedPoolIds.size === 0 || restoreLoading}
              style={{
                padding: "5px 14px",
                border: "1px solid rgba(0,170,255,0.3)",
                borderRadius: "3px",
                background: "rgba(0,170,255,0.06)",
                color: "var(--info)",
                fontSize: "11px",
                fontFamily: "'JetBrains Mono', monospace",
                cursor: selectedPoolIds.size === 0 || restoreLoading ? "not-allowed" : "pointer",
                opacity: selectedPoolIds.size === 0 ? 0.7 : 1,
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              {restoreLoading ? <Spinner size={14} /> : null}
              Restore Selected
            </button>
          )}

          <button
            onClick={handleArchiveSelected}
            disabled={selectedPoolIds.size === 0 || archiveLoading}
            title="Archive does not remove listing history or My Listings data."
            style={{
              padding: "5px 14px",
              border: "1px solid rgba(255,68,85,0.3)",
              borderRadius: "3px",
              background: "rgba(255,68,85,0.06)",
              color: "var(--danger)",
              fontSize: "11px",
              fontFamily: "'JetBrains Mono', monospace",
              cursor: selectedPoolIds.size === 0 || archiveLoading ? "not-allowed" : "pointer",
              opacity: selectedPoolIds.size === 0 ? 0.7 : 1,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            {archiveLoading ? <Spinner size={14} /> : null}
            Archive Selected
          </button>

          <button
            onClick={() => setDispatchModalOpen(true)}
            disabled={selectedPoolIds.size === 0 || dispatchLoading}
            style={{
              padding: "5px 14px",
              border: "1px solid rgba(0,255,136,0.3)",
              borderRadius: "3px",
              background: "rgba(0,255,136,0.06)",
              color: "var(--accent)",
              fontSize: "11px",
              fontFamily: "'JetBrains Mono', monospace",
              cursor: selectedPoolIds.size === 0 || dispatchLoading ? "not-allowed" : "pointer",
              opacity: selectedPoolIds.size === 0 ? 0.7 : 1,
              transition: "all 0.15s",
            }}
          >
            ▶ Dispatch Selected
          </button>

          <button onClick={load} style={{ padding: "5px 14px", border: "1px solid var(--border)", borderRadius: "3px", background: "var(--surface)", color: "var(--sub)", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace", cursor: "pointer" }}>
            ↻ Refresh
          </button>
        </div>
      </div>
      )}

      {!showAdvanced && (
        <p style={{ fontSize: "11px", color: "var(--sub)", marginBottom: "12px", lineHeight: 1.5 }}>
          ASINs waiting to be listed. Published items appear in My Listings.
        </p>
      )}

      {selectedPoolIds.size > 0 && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          marginBottom: "12px",
          padding: "8px 12px",
          border: "1px solid var(--border)",
          borderRadius: "3px",
          background: "var(--surface)",
        }}>
          <span style={{ fontSize: "11px", color: "var(--sub)", fontFamily: "'JetBrains Mono', monospace" }}>
            {selectedPoolIds.size} selected
          </span>
          <button
            onClick={() => void handleDeleteSelected()}
            disabled={deleteLoading}
            style={{
              padding: "5px 14px",
              border: "1px solid rgba(255,68,85,0.45)",
              borderRadius: "3px",
              background: "rgba(255,68,85,0.1)",
              color: "var(--danger)",
              fontSize: "11px",
              fontFamily: "'JetBrains Mono', monospace",
              cursor: deleteLoading ? "not-allowed" : "pointer",
              opacity: deleteLoading ? 0.7 : 1,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            {deleteLoading ? <Spinner size={14} /> : null}
            Delete Selected
          </button>
        </div>
      )}

      {/* Table */}
      <div style={{ border: "1px solid var(--border)", borderRadius: "3px", overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: showAdvanced ? "28px 130px 1fr 90px 90px 90px 160px 100px 110px" : "28px 130px 1fr 150px 90px", padding: "8px 12px", background: "var(--surface)", borderBottom: "1px solid var(--border)", fontSize: "10px", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
            <input
              ref={headerCheckboxRef}
              type="checkbox"
              checked={allVisibleSelected}
              onChange={(e) => {
                if (e.target.checked) setSelectedPoolIds(new Set(visiblePoolIds))
                else setSelectedPoolIds(new Set())
              }}
            />
          </div>
          <div>ASIN</div>
          <div>Title</div>
          {showAdvanced ? (
            <>
              <div>Stage</div>
              <div>Scrape</div>
              <div>AI</div>
              <div>List</div>
              <div>Store</div>
              <div>Updated</div>
            </>
          ) : (
            <>
              <div>Date Added</div>
              <div>Source</div>
            </>
          )}
        </div>

        {loading ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", fontSize: "13px" }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", fontSize: "13px" }}>No records found</div>
        ) : (
          pagedRows.map((row: PoolRow, i: number) => (
            <div key={row.poolId}>
            <div style={{
              display: "grid",
              gridTemplateColumns: showAdvanced ? "28px 130px 1fr 90px 90px 90px 160px 100px 110px" : "28px 130px 1fr 150px 90px",
              padding: "7px 12px", fontSize: "12px",
              background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
              borderBottom: "1px solid var(--border)",
            }}>
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={selectedPoolIds.has(row.poolId)}
                  onChange={(e) => {
                    const next = new Set(selectedPoolIds)
                    if (e.target.checked) next.add(row.poolId)
                    else next.delete(row.poolId)
                    setSelectedPoolIds(next)
                  }}
                />
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "var(--text)", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                {showAdvanced && <Dot color={stageColor(row.pipelineStage)} />}
                <a
                  href={amazonUrl(row.asin)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--info)", textDecoration: "none" }}
                >
                  {row.asin}
                </a>
                {showAdvanced && row.archivedAt && (
                  <Badge value="Archived" color="var(--sub)" />
                )}
              </div>
              <div style={{ fontSize: "12px", color: "var(--sub)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: "8px" }}>
                {row.title ?? <span style={{ color: "var(--dim)" }}>—</span>}
              </div>
              {showAdvanced ? (
                <>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <Badge value={row.pipelineStage.replace("_", " ")} color={stageColor(row.pipelineStage)} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <Badge value={row.scrapeStatus} color={statusColor(row.scrapeStatus)} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <Badge value={row.aiStatus} color={statusColor(row.aiStatus)} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    {row.pipelineStage === "scraped" || row.pipelineStage === "ai_generated" ? (
                      <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                        <select
                          value={
                            publishStoreByPoolId[row.poolId] ??
                            row.assignedStoreCode ??
                            stores[0]?.storeCode ??
                            "S1"
                          }
                          disabled={!!publishLoadingByPoolId[row.poolId]}
                          onChange={(e) => setPublishStoreByPoolId(prev => ({ ...prev, [row.poolId]: e.target.value }))}
                          style={{
                            background: "var(--surface)",
                            border: "1px solid var(--border)",
                            borderRadius: "3px",
                            padding: "4px 6px",
                            color: "var(--text)",
                            fontSize: "10px",
                            fontFamily: "'JetBrains Mono', monospace",
                            maxWidth: 72,
                          }}
                        >
                          {stores.map((s) => (
                            <option key={s.id} value={s.storeCode}>
                              {s.name?.trim() || "Store"}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          min={1}
                          max={999}
                          value={publishQuantityByPoolId[row.poolId] ?? 1}
                          onChange={(e) => setPublishQuantityByPoolId(prev => ({
                            ...prev,
                            [row.poolId]: Math.max(1, parseInt(e.target.value) || 1),
                          }))}
                          style={{
                            width: 40,
                            background: "var(--surface)",
                            border: "1px solid var(--border)",
                            borderRadius: "3px",
                            padding: "4px 4px",
                            color: "var(--text)",
                            fontSize: "10px",
                            fontFamily: "'JetBrains Mono', monospace",
                            textAlign: "center",
                          }}
                        />
                        <button
                          style={actionBtn("publish", !!publishLoadingByPoolId[row.poolId])}
                          disabled={!!publishLoadingByPoolId[row.poolId]}
                          onClick={() => void handlePublish(row)}
                          title="Direct List — uses Title Mode above"
                        >
                          {publishLoadingByPoolId[row.poolId] ? <Spinner size={14} /> : "List"}
                        </button>
                      </div>
                    ) : (
                      <Badge value={row.listingStatus} color={statusColor(row.listingStatus)} />
                    )}
                  </div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: row.assignedStoreCode ? "var(--info)" : "var(--dim)", display: "flex", alignItems: "center" }}>
                    {poolStoreDisplayName(stores, row.assignedStoreCode, row.assignedStoreName)}
                  </div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color: "var(--dim)", display: "flex", alignItems: "center" }}>
                    {fmtPoolDate(row.updatedAt)}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color: "var(--dim)", display: "flex", alignItems: "center" }}>
                    {fmtPoolDate(row.createdAt ?? row.updatedAt)}
                  </div>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <a
                      href={amazonUrl(row.asin)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 11, color: "var(--info)", textDecoration: "none", fontFamily: "'JetBrains Mono', monospace" }}
                    >
                      Amazon
                    </a>
                  </div>
                </>
              )}
            </div>
            </div>
          ))
        )}
      </div>

      {!loading && (
        <>
          <div
            style={{
              marginTop: "10px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            <button
              type="button"
              onClick={() => setPoolPage((p) => Math.max(1, p - 1))}
              disabled={poolPage === 1}
              style={{
                padding: "6px 10px",
                border: "1px solid var(--border)",
                borderRadius: "3px",
                background: "var(--surface)",
                color: "var(--sub)",
                fontSize: "11px",
                cursor: poolPage === 1 ? "not-allowed" : "pointer",
                opacity: poolPage === 1 ? 0.6 : 1,
              }}
            >
              ← Prev
            </button>

            <div style={{ fontSize: "11px", color: "var(--dim)" }}>
              Page {poolPage} of {totalPages}
            </div>

            <button
              type="button"
              onClick={() => setPoolPage((p) => Math.min(totalPages, p + 1))}
              disabled={poolPage >= totalPages}
              style={{
                padding: "6px 10px",
                border: "1px solid var(--border)",
                borderRadius: "3px",
                background: "var(--surface)",
                color: "var(--sub)",
                fontSize: "11px",
                cursor: poolPage >= totalPages ? "not-allowed" : "pointer",
                opacity: poolPage >= totalPages ? 0.6 : 1,
              }}
            >
              Next →
            </button>
          </div>

          <div style={{ marginTop: "10px", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "var(--dim)" }}>
            {pagedRows.length} of {rows.length} rows (page {poolPage})
          </div>
        </>
      )}

      {/* Category Preferences */}
      <div style={{ padding: "14px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", marginTop: "24px", marginBottom: "20px" }}>
        <div style={{ fontSize: "12px", fontWeight: 900, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", marginBottom: 10 }}>
          ASIN Request / Category Preferences
        </div>
        <p style={{ fontSize: 11, color: "var(--sub)", marginBottom: 12, lineHeight: 1.5 }}>
          Select the categories you want us to source and list for you.
        </p>
        {categoryLoading ? (
          <p style={{ fontSize: 11, color: "var(--dim)", marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" }}>Loading preferences…</p>
        ) : categoryError ? (
          <p style={{ fontSize: 11, color: "var(--danger)", marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" }}>{categoryError}</p>
        ) : null}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8, marginBottom: 12, opacity: categoryLoading ? 0.6 : 1 }}>
          {CATEGORY_OPTIONS.map((category) => (
            <label key={category} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text)", cursor: categoryLoading ? "not-allowed" : "pointer" }}>
              <input
                type="checkbox"
                disabled={categoryLoading}
                checked={categoryPrefs.categories.includes(category)}
                onChange={() => toggleCategory(category)}
              />
              {category}
            </label>
          ))}
        </div>
        <label style={{ display: "block", fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace", marginBottom: 6 }}>
          Optional note
        </label>
        <textarea
          value={categoryPrefs.note}
          disabled={categoryLoading}
          onChange={(e) => setCategoryPrefs((prev) => ({ ...prev, note: e.target.value }))}
          rows={2}
          placeholder="Short note about category focus or restrictions"
          style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "3px", padding: "8px 10px", color: "var(--text)", fontSize: 12, fontFamily: "'JetBrains Mono', monospace", marginBottom: 12, resize: "vertical" }}
        />
        <button
          type="button"
          onClick={() => void saveCategoryPreferences()}
          disabled={categorySaving || categoryLoading}
          style={{
            padding: "10px 16px",
            borderRadius: "3px",
            border: "1px solid rgba(0,255,136,0.3)",
            background: "var(--accent)",
            color: "#000",
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 900,
            cursor: categorySaving ? "not-allowed" : "pointer",
            opacity: categorySaving ? 0.7 : 1,
            textTransform: "uppercase",
          }}
        >
          Save Preferences
        </button>
        {categorySaveStatus && (
          <p style={{ marginTop: 10, fontSize: 11, color: "var(--accent)", fontFamily: "'JetBrains Mono', monospace" }}>
            {categorySaveStatus}
          </p>
        )}
      </div>

      {/* Dispatch Selected Modal */}
      {dispatchModalOpen && (
        <div
          onClick={() => setDispatchModalOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 420,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              padding: 14,
              boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)" }}>
                Dispatch Selected ({selectedPoolIds.size} items)
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: "var(--sub)" }}>
                Store: {selectedStoreDisplayLabel}
              </p>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)" }}>
                    Stock Quantity
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={dispatchQuantity}
                    onChange={(e) => setDispatchQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                    style={{
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      borderRadius: "3px",
                      padding: "8px 10px",
                      color: "var(--text)",
                      fontSize: 13,
                      fontFamily: "'JetBrains Mono', monospace",
                      outline: "none",
                    }}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)" }}>
                    Delay Between Items (s)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={3600}
                    value={dispatchDelay}
                    onChange={(e) => setDispatchDelay(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      borderRadius: "3px",
                      padding: "8px 10px",
                      color: "var(--text)",
                      fontSize: 13,
                      fontFamily: "'JetBrains Mono', monospace",
                      outline: "none",
                    }}
                  />
                </div>
              </div>

              <div style={{ fontSize: 12, color: "var(--dim)", lineHeight: 1.4, paddingTop: 2 }}>
                {selectedPoolIds.size} items will be queued for extension worker processing
              </div>

              <div style={{ display: "flex", gap: 12 }}>
                <button
                  onClick={() => setDispatchModalOpen(false)}
                  disabled={dispatchLoading}
                  style={{
                    flex: 1,
                    padding: "11px 0",
                    borderRadius: "3px",
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--sub)",
                    fontSize: 13,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 800,
                    cursor: dispatchLoading ? "not-allowed" : "pointer",
                    opacity: dispatchLoading ? 0.7 : 1,
                    textTransform: "uppercase",
                    letterSpacing: "1px",
                  }}
                >
                  Cancel
                </button>

                <button
                  onClick={() => void handleDispatchSelected()}
                  disabled={dispatchLoading}
                  style={{
                    flex: 1,
                    padding: "11px 0",
                    borderRadius: "3px",
                    border: "1px solid rgba(0,255,136,0.3)",
                    background: "var(--accent)",
                    color: "#000",
                    fontSize: 13,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 900,
                    cursor: dispatchLoading ? "not-allowed" : "pointer",
                    opacity: dispatchLoading ? 0.6 : 1,
                    textTransform: "uppercase",
                    letterSpacing: "1px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                  }}
                >
                  {dispatchLoading ? <Spinner size={14} /> : "▶ Start Dispatch"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
