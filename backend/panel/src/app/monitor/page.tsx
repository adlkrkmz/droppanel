"use client"

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { createPortal } from "react-dom"
import { getMonitorListings, postMonitorUpdatePrice, postMonitorUpdateStock, postMonitorBlind } from "@/lib/api"
import type { MonitorItem } from "@/lib/api"
import { useStore } from "@/lib/storeContext"
import { useToast } from "@/lib/toastContext"

// ─── HELPERS ──────────────────────────────────────────────────

function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n)
}

function hasValidPrice(item: MonitorItem): boolean {
  return isFiniteNum(item.ebayPrice) && item.ebayPrice > 0
}

function hasValidCost(item: MonitorItem): boolean {
  return item.cost != null && isFiniteNum(item.cost)
}

function isErrorItem(item: MonitorItem): boolean {
  if (!Number.isFinite(item.quantity)) return true
  if (!hasValidPrice(item)) return true
  if (item.status === "TRACKED" && !item.ebayItemId?.trim()) return true
  return false
}

function displayPriceText(item: MonitorItem): string {
  if (!hasValidPrice(item)) return "No Price"
  return `$${item.ebayPrice.toFixed(2)}`
}

function displayCostText(item: MonitorItem): string {
  if (!hasValidCost(item)) return "No Cost"
  return `$${item.cost!.toFixed(2)}`
}

function displayQty(item: MonitorItem): string {
  if (!Number.isFinite(item.quantity)) return "—"
  return String(item.quantity)
}

function displayMargin(item: MonitorItem): string {
  const m = item.margin
  if (m === null || m === undefined || !Number.isFinite(m)) return "—"
  return `${m.toFixed(1)}%`
}

function marginColorFromItem(item: MonitorItem): string {
  const m = item.margin
  if (m === null || m === undefined || !Number.isFinite(m)) return "var(--dim)"
  if (m >= 20) return "var(--accent)"
  if (m >= 10) return "var(--warn)"
  return "var(--danger)"
}

function formatIso(iso: string | null): string {
  if (!iso?.trim()) return "—"
  const x = Date.parse(iso)
  if (!Number.isFinite(x)) return "—"
  try {
    return new Date(x).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
  } catch {
    return "—"
  }
}

type MonitorFilter = "all" | "TRACKED" | "UNTRACKED" | "BLIND" | "ERROR" | "NO_COST" | "QTY0"

function passesFilter(item: MonitorItem, filter: MonitorFilter): boolean {
  switch (filter) {
    case "all":
      return true
    case "TRACKED":
      return item.status === "TRACKED"
    case "UNTRACKED":
      return item.status === "UNTRACKED"
    case "BLIND":
      return item.quantity === 0 && item.status === "TRACKED"
    case "ERROR":
      return isErrorItem(item)
    case "NO_COST":
      return !hasValidCost(item)
    case "QTY0":
      return item.quantity === 0
    default:
      return true
  }
}

function TrackedBadge({ status }: { status: MonitorItem["status"] }) {
  const tracked = status === "TRACKED"
  return (
    <span style={{
      padding: "2px 8px", borderRadius: "20px", fontSize: "10px", fontWeight: 700,
      fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase",
      background: tracked ? "rgba(0,255,136,0.12)" : "rgba(136,136,136,0.12)",
      color: tracked ? "var(--accent)"        : "var(--dim)",
    }}>
      {status}
    </span>
  )
}

function Spinner({ size = "md" }: { size?: "sm" | "md" }) {
  const dim = size === "sm" ? "h-4 w-4 border-2" : "h-9 w-9 border-2"
  return (
    <span
      className={`inline-block shrink-0 rounded-full border-[var(--border)] border-t-[var(--accent)] animate-spin ${dim}`}
      role="status"
      aria-label="Loading"
    />
  )
}

const filterButtons: { key: MonitorFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "TRACKED", label: "Tracked" },
  { key: "UNTRACKED", label: "Untracked" },
  { key: "BLIND", label: "Blind" },
  { key: "ERROR", label: "Error" },
  { key: "NO_COST", label: "No Cost" },
  { key: "QTY0", label: "QTY=0" },
]

// ─── EDIT MODAL ───────────────────────────────────────────────

type EditFields = { stock: number; cost: number; ebayPrice: number }

function EditModal({
  item,
  onClose,
  onSave,
  showToast,
}: {
  item: MonitorItem
  onClose: () => void
  onSave: (fields: EditFields) => Promise<void>
  showToast: (msg: string, type?: "success" | "error") => void
}) {
  const [saving, setSaving] = useState(false)
  const [fields, setFields] = useState<EditFields>({
    stock:     Number.isFinite(item.quantity) ? item.quantity : 0,
    cost:      hasValidCost(item) ? item.cost! : 0,
    ebayPrice: hasValidPrice(item) ? item.ebayPrice : 0,
  })

  const marginVal = fields.ebayPrice > 0 && Number.isFinite(fields.cost)
    ? ((fields.ebayPrice - fields.cost) / fields.ebayPrice) * 100
    : NaN
  const calcMargin = Number.isFinite(marginVal) ? marginVal.toFixed(1) : "—"

  const inputSt: React.CSSProperties = {
    background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "3px",
    padding: "7px 10px", color: "var(--text)", fontSize: "13px",
    fontFamily: "'JetBrains Mono', monospace", width: "100%", outline: "none",
  }

  return (
    <div>
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.7)",
          zIndex: 9998,
        }}
        onClick={onClose}
        aria-hidden
      />
      <div
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 9999,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "6px",
          padding: "24px",
          width: "360px",
          maxWidth: "calc(100vw - 32px)",
        }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-modal-title"
      >
        <p id="edit-modal-title" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)", marginBottom: "16px" }}>
          Edit Listing
        </p>
        <p style={{ fontSize: "12px", color: "var(--sub)", marginBottom: "16px", fontFamily: "'JetBrains Mono', monospace" }}>
          {item.sku}
        </p>

        {[
          { label: "Stock", key: "stock" as const },
          { label: "Cost ($)", key: "cost" as const },
          { label: "eBay Price ($)", key: "ebayPrice" as const },
        ].map(({ label, key }) => (
          <div key={key} style={{ marginBottom: "12px" }}>
            <label htmlFor={`edit-${key}`} style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", display: "block", marginBottom: "6px" }}>
              {label}
            </label>
            <input
              id={`edit-${key}`}
              type="number"
              step="0.01"
              value={fields[key]}
              onChange={e => setFields(prev => ({ ...prev, [key]: parseFloat(e.target.value) || 0 }))}
              style={inputSt}
            />
          </div>
        ))}

        <div style={{ padding: "10px 12px", background: "var(--bg)", borderRadius: "3px", marginBottom: "16px", fontFamily: "'JetBrains Mono', monospace", fontSize: "13px" }}>
          <span style={{ color: "var(--dim)" }}>Margin: </span>
          <span style={{ color: calcMargin === "—" ? "var(--dim)" : marginColorFromItem({ ...item, margin: parseFloat(calcMargin) }), fontWeight: 700 }}>{calcMargin}{calcMargin === "—" ? "" : "%"}</span>
        </div>

        <div style={{ display: "flex", gap: "10px" }}>
          <button
            onClick={async () => {
              setSaving(true)
              try {
                await onSave(fields)
                onClose()
              } catch (e) {
                showToast(e instanceof Error ? e.message : "Save failed", "error")
              } finally {
                setSaving(false)
              }
            }}
            style={{ flex: 1, padding: "9px", borderRadius: "3px", border: "none", cursor: "pointer", background: "var(--accent)", color: "#000", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: "11px", textTransform: "uppercase" }}
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            onClick={onClose}
            style={{ flex: 1, padding: "9px", borderRadius: "3px", border: "1px solid var(--border)", cursor: "pointer", background: "transparent", color: "var(--sub)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px" }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── DETAIL DRAWER ────────────────────────────────────────────

function DetailDrawer({
  item,
  lastFetchAt,
  onClose,
  onSync,
  onBlind,
  onUnblind,
  onRetry,
  busy,
}: {
  item: MonitorItem
  lastFetchAt: string | null
  onClose: () => void
  onSync: () => void
  onBlind: () => void
  onUnblind: () => void
  onRetry: () => void
  busy: boolean
}) {
  const blinded = item.quantity === 0
  const row = (label: string, value: string) => (
    <div key={label} style={{ marginBottom: "14px" }}>
      <p style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", marginBottom: "4px" }}>{label}</p>
      <p style={{ fontSize: "13px", color: "var(--text)", fontFamily: "'JetBrains Mono', monospace", wordBreak: "break-word" }}>{value}</p>
    </div>
  )

  const lastSync = formatIso(item.listedAt) !== "—" ? formatIso(item.listedAt) : (lastFetchAt ? formatIso(lastFetchAt) : "—")

  return (
    <>
      <div
        role="presentation"
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 10000 }}
        onClick={onClose}
      />
      <aside
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          height: "100vh",
          width: "min(400px, 100vw)",
          background: "var(--surface)",
          borderLeft: "1px solid var(--border)",
          zIndex: 10001,
          display: "flex",
          flexDirection: "column",
          boxShadow: "-8px 0 24px rgba(0,0,0,0.25)",
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: "20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)" }}>Detail</p>
          <button
            type="button"
            onClick={onClose}
            style={{ border: "none", background: "transparent", color: "var(--sub)", cursor: "pointer", fontSize: "18px", lineHeight: 1, padding: "4px" }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div style={{ padding: "20px", overflowY: "auto", flex: 1 }}>
          {row("SKU", item.sku?.trim() || "—")}
          {row("ASIN", item.asin?.trim() || "—")}
          {row("eBay item id", item.ebayItemId?.trim() || "—")}
          {row("Price", displayPriceText(item))}
          {row("Cost", displayCostText(item))}
          {row("QTY", displayQty(item))}
          {row("Last sync", lastSync)}
        </div>
        <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: "8px" }}>
          <button
            type="button"
            disabled={busy}
            onClick={onSync}
            style={{ padding: "10px", borderRadius: "3px", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", fontWeight: 600, cursor: busy ? "wait" : "pointer" }}
          >
            Sync
          </button>
          {blinded ? (
            <button
              type="button"
              disabled={busy}
              onClick={onUnblind}
              style={{ padding: "10px", borderRadius: "3px", border: "1px solid var(--accent)", background: "rgba(0,255,136,0.08)", color: "var(--accent)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", fontWeight: 600, cursor: busy ? "wait" : "pointer" }}
            >
              Unblind
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onBlind}
              style={{ padding: "10px", borderRadius: "3px", border: "none", background: "transparent", color: "var(--danger)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", fontWeight: 600, cursor: busy ? "wait" : "pointer" }}
            >
              Blind
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onRetry}
            style={{ padding: "10px", borderRadius: "3px", border: "1px solid var(--info)", background: "var(--surface)", color: "var(--info)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", fontWeight: 600, cursor: busy ? "wait" : "pointer" }}
          >
            Retry
          </button>
        </div>
      </aside>
    </>
  )
}

// ─── PRODUCT CARD ─────────────────────────────────────────────

type MonitorSortKey = "listed_desc" | "listed_asc" | "price_desc" | "price_asc"

function ProductCard({ item, onEdit, onBlind, onSync, onDetail, selectMode, selected, onToggleSelect }: {
  item:           MonitorItem
  onEdit:         (item: MonitorItem) => void
  onBlind:        (item: MonitorItem) => void
  onSync:         (item: MonitorItem) => void
  onDetail:       (item: MonitorItem) => void
  selectMode:     boolean
  selected:       boolean
  onToggleSelect: (sku: string) => void
}) {
  const sku = item.sku?.trim() || ""
  const showCb = selectMode && Boolean(sku)

  const btnBase: React.CSSProperties = {
    flex: 1,
    padding: "7px 4px",
    border: "none",
    cursor: "pointer",
    background: "transparent",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: "10px",
    fontWeight: 600,
    minWidth: 0,
  }

  return (
    <div style={{
      position: "relative",
      background: "var(--surface)",
      border:     selected ? "2px solid var(--accent)" : "1px solid var(--border)",
      borderRadius: "4px",
      overflow:   "hidden", display: "flex", flexDirection: "column",
      transition: "border-color 0.15s, border-width 0.15s",
      boxSizing:  "border-box",
    }}>
      {selected && (
        <div
          style={{
            position:       "absolute",
            inset:          0,
            pointerEvents:  "none",
            background:     "rgba(0,255,136,0.07)",
            borderRadius:   "inherit",
            zIndex:         1,
          }}
          aria-hidden
        />
      )}
      {showCb && (
        <label
          style={{
            position:       "absolute",
            top:            8,
            left:           8,
            zIndex:         8,
            display:        "flex",
            alignItems:     "center",
            cursor:         "pointer",
            background:     "var(--surface)",
            borderRadius:   "3px",
            padding:        "2px",
            border:         "1px solid var(--border)",
          }}
          onClick={e => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(sku)}
            style={{ width: "16px", height: "16px", cursor: "pointer", accentColor: "var(--accent)" }}
          />
        </label>
      )}
      <div style={{ height: "130px", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", borderBottom: "1px solid var(--border)", overflow: "hidden", position: "relative", zIndex: 0 }}>
        {item.image
          ? <img src={item.image} alt={item.title || "—"} style={{ maxHeight: "110px", maxWidth: "100%", objectFit: "contain" }} onError={e => { (e.target as HTMLImageElement).style.display = "none" }} />
          : <span style={{ fontSize: "28px", opacity: 0.2 }}>&#128230;</span>
        }
      </div>

      <div style={{ padding: "12px", flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
          <p style={{ fontSize: "12px", color: "var(--text)", lineHeight: "1.4", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>
            {item.title?.trim() || "—"}
          </p>
          <TrackedBadge status={item.status} />
        </div>

        <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color: "var(--dim)" }}>
          {item.sku?.trim() || "—"}
        </p>

        {item.asin?.trim() ? (
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color: "var(--info)" }}>
            {item.asin}
          </p>
        ) : null}

        {item.ebayItemId?.trim() ? (
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "9px", color: "var(--dim)", marginTop: "2px" }}>
            eBay: {item.ebayItemId}
          </p>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", marginTop: "4px" }}>
          {[
            { label: "Price",  value: displayPriceText(item), color: "var(--text)" },
            { label: "Cost",   value: displayCostText(item), color: "var(--sub)" },
            { label: "Margin", value: displayMargin(item),    color: marginColorFromItem(item) },
            { label: "Qty",    value: displayQty(item), color: item.quantity > 0 ? "var(--text)" : "var(--danger)" },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ padding: "6px 8px", background: "var(--bg)", borderRadius: "3px" }}>
              <p style={{ fontSize: "9px", letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>{label}</p>
              <p style={{ fontSize: "13px", fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace", marginTop: "2px" }}>{value}</p>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderTop: "1px solid var(--border)" }}>
        <button type="button" onClick={() => onEdit(item)} style={{ ...btnBase, color: "var(--sub)", borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>Edit</button>
        <button type="button" onClick={() => onBlind(item)} style={{ ...btnBase, color: "var(--danger)", borderBottom: "1px solid var(--border)" }}>Blind</button>
        <button type="button" onClick={() => onSync(item)} style={{ ...btnBase, color: "var(--text)", borderRight: "1px solid var(--border)" }}>Sync</button>
        <button type="button" onClick={() => onDetail(item)} style={{ ...btnBase, color: "var(--info)" }}>Detail</button>
      </div>
    </div>
  )
}

// ─── MAIN PAGE ────────────────────────────────────────────────

export default function MonitorPage() {
  const { selectedStore } = useStore()
  const { showToast } = useToast()
  const [items, setItems]     = useState<MonitorItem[]>([])
  const [stats,     setStats]     = useState({
    ebayInventoryTotal: 0,
    tracked:            0,
    untracked:          0,
    sim:                true,
  })
  const [lastFetchAt, setLastFetchAt] = useState<string | null>(null)
  const [totalPages, setTotalPages] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(50)
  const [loading,   setLoading]   = useState(true)
  const [search,    setSearch]    = useState("")
  const [filter,    setFilter]    = useState<MonitorFilter>("all")
  const [editItem,  setEditItem]  = useState<MonitorItem | null>(null)
  const [detailItem, setDetailItem] = useState<MonitorItem | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedSkus, setSelectedSkus] = useState<Set<string>>(() => new Set())
  const [sortKey, setSortKey] = useState<MonitorSortKey>("listed_desc")
  const [panCopyFeedback, setPanCopyFeedback] = useState<string | null>(null)
  const [drawerBusy, setDrawerBusy] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const skipScrollRef = useRef(true)

  const kpiBlind = useMemo(() => items.filter(i => i.quantity === 0).length, [items])
  const kpiError = useMemo(() => items.filter(isErrorItem).length, [items])

  useEffect(() => {
    setCurrentPage(1)
    setSelectMode(false)
    setSelectedSkus(new Set())
  }, [selectedStore])

  const load = useCallback(async (): Promise<boolean> => {
    setLoading(true)
    try {
      const res = await getMonitorListings(selectedStore, {
        offset: (currentPage - 1) * pageSize,
        limit:  pageSize,
      })
      setItems(res.items)
      setLastFetchAt(res.generatedAt ?? null)
      setStats({
        ebayInventoryTotal: typeof res.ebayInventoryTotal === "number" ? res.ebayInventoryTotal : 0,
        tracked:            res.tracked,
        untracked:          res.untracked,
        sim:                res.simulationMode,
      })
      const tp = Math.max(1, res.totalPages)
      setTotalPages(tp)
      setCurrentPage(cp => Math.min(cp, tp))
      return true
    } catch (e) {
      setItems([])
      setLastFetchAt(null)
      setStats({ ebayInventoryTotal: 0, tracked: 0, untracked: 0, sim: false })
      setTotalPages(1)
      showToast(e instanceof Error ? e.message : "Failed to load listings", "error")
      return false
    } finally {
      setLoading(false)
    }
  }, [selectedStore, currentPage, pageSize, showToast])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false
      return
    }
    window.scrollTo({ top: 0, behavior: "smooth" })
  }, [currentPage])

  async function handleBlind(item: MonitorItem) {
    try {
      await postMonitorBlind(selectedStore, item.sku)
      setItems(prev => prev.map(i => i.sku === item.sku ? { ...i, quantity: 0 } : i))
      showToast("Blind applied", "success")
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Blind failed", "error")
    }
  }

  async function handleSave(item: MonitorItem, fields: EditFields): Promise<void> {
    const priceChanged = fields.ebayPrice !== item.ebayPrice
    const stockChanged = fields.stock     !== item.quantity

    if (priceChanged) {
      await postMonitorUpdatePrice(selectedStore, item.sku, fields.ebayPrice)
    }
    if (stockChanged) {
      await postMonitorUpdateStock(selectedStore, item.sku, fields.stock)
    }

    const newMargin = fields.ebayPrice > 0 && fields.cost > 0 && Number.isFinite(fields.cost)
      ? Math.round(((fields.ebayPrice - fields.cost) / fields.ebayPrice) * 100 * 100) / 100
      : null

    setItems(prev => prev.map(i => i.sku === item.sku
      ? { ...i, ebayPrice: fields.ebayPrice, quantity: fields.stock, cost: fields.cost, margin: newMargin }
      : i
    ))
    showToast("Saved", "success")
  }

  async function handleSyncOne(_item: MonitorItem) {
    const ok = await load()
    if (ok) showToast("List refreshed", "success")
  }

  const filtered = items.filter(item => {
    if (!passesFilter(item, filter)) return false
    if (search) {
      const q = search.toLowerCase()
      return item.sku.toLowerCase().includes(q) ||
             (item.title ?? "").toLowerCase().includes(q) ||
             (item.asin?.toLowerCase().includes(q) ?? false) ||
             (item.ebayItemId?.toLowerCase().includes(q) ?? false)
    }
    return true
  })

  const displayItems = useMemo(() => {
    const arr = [...filtered]
    const ts = (iso: string | null) => {
      if (!iso) return null
      const x = Date.parse(iso)
      return Number.isFinite(x) ? x : null
    }
    const safePrice = (p: MonitorItem) => (Number.isFinite(p.ebayPrice) ? p.ebayPrice : Number.NEGATIVE_INFINITY)
    switch (sortKey) {
      case "listed_desc":
        arr.sort((a, b) => {
          const na = ts(a.listedAt) ?? Number.NEGATIVE_INFINITY
          const nb = ts(b.listedAt) ?? Number.NEGATIVE_INFINITY
          if (nb !== na) return nb - na
          return a.sku.localeCompare(b.sku)
        })
        break
      case "listed_asc":
        arr.sort((a, b) => {
          const na = ts(a.listedAt) ?? Number.POSITIVE_INFINITY
          const nb = ts(b.listedAt) ?? Number.POSITIVE_INFINITY
          if (na !== nb) return na - nb
          return a.sku.localeCompare(b.sku)
        })
        break
      case "price_desc":
        arr.sort((a, b) => safePrice(b) - safePrice(a) || a.sku.localeCompare(b.sku))
        break
      case "price_asc":
        arr.sort((a, b) => safePrice(a) - safePrice(b) || a.sku.localeCompare(b.sku))
        break
      default:
        break
    }
    return arr
  }, [filtered, sortKey])

  function toggleSelectedSku(sku: string) {
    setSelectedSkus(prev => {
      const next = new Set(prev)
      if (next.has(sku)) next.delete(sku)
      else next.add(sku)
      return next
    })
  }

  async function bulkBlindSelected() {
    const skus = [...selectedSkus]
    if (skus.length === 0) return
    setBulkBusy(true)
    const succeeded = new Set<string>()
    try {
      for (const sku of skus) {
        try {
          await postMonitorBlind(selectedStore, sku)
          succeeded.add(sku)
        } catch {
          /* sonunda toplu mesaj */
        }
      }
      if (succeeded.size > 0) {
        setItems(prev => prev.map(i => (succeeded.has(i.sku) ? { ...i, quantity: 0 } : i)))
      }
      const fail = skus.length - succeeded.size
      if (fail === 0) showToast(`Blind: ${succeeded.size} listing(s)`, "success")
      else if (succeeded.size > 0) showToast(`Blind: ${succeeded.size} ok, ${fail} failed`, "error")
      else showToast(`Blind failed for ${fail} listing(s)`, "error")
    } finally {
      setBulkBusy(false)
    }
  }

  async function copyEaSyncFromSelection() {
    const rows = displayItems
      .filter(i => {
        const id = i.ebayItemId?.trim()
        return id && selectedSkus.has(i.sku) && i.asin?.trim()
      })
      .map(i => `${i.ebayItemId!.trim()},${i.asin!.trim()}`)
    const text = ["ebay_item_id,product_id", ...rows].join("\n")
    try {
      await navigator.clipboard.writeText(text)
      setPanCopyFeedback("Copied!")
      window.setTimeout(() => setPanCopyFeedback(null), 2000)
      showToast("Copied to clipboard", "success")
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Clipboard failed", "error")
    }
  }

  const selectedCount = selectedSkus.size
  const bulkBar = selectedCount > 0

  return (
    <div style={{ maxWidth: "1200px", animation: "fade-in 0.3s ease forwards" }}>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "12px", marginBottom: "20px" }}>
        {[
          { label: "Total",     value: stats.ebayInventoryTotal, color: "var(--text)"   },
          { label: "Tracked",   value: stats.tracked,              color: "var(--accent)" },
          { label: "Untracked", value: stats.untracked,            color: "var(--dim)"    },
          { label: "Blind",     value: kpiBlind,                 color: "var(--warn)"   },
          { label: "Error",     value: kpiError, color: "var(--danger)" },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ padding: "12px 16px", background: "var(--surface)", border: "1px solid var(--border)", borderTop: `2px solid ${color}`, borderRadius: "3px" }}>
            <p style={{ fontSize: "10px", letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>{label}</p>
            <p style={{ fontSize: "22px", fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace", marginTop: "4px" }}>{value}</p>
          </div>
        ))}
      </div>

      {bulkBar && (
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 50,
            marginBottom: "16px",
            padding: "12px 16px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "12px",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "12px",
            boxShadow: "0 2px 12px rgba(0,0,0,0.15)",
          }}
        >
          <span style={{ color: "var(--text)", fontWeight: 700 }}>{selectedCount} seçildi</span>
          <span style={{ color: "var(--border)", userSelect: "none" }}>|</span>
          <button
            type="button"
            disabled={bulkBusy || loading}
            onClick={async () => {
              const ok = await load()
              if (ok) showToast("List refreshed", "success")
            }}
            style={{ padding: "6px 12px", borderRadius: "3px", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontFamily: "inherit", fontSize: "11px", fontWeight: 600, cursor: bulkBusy || loading ? "wait" : "pointer" }}
          >
            Sync Selected
          </button>
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => { void bulkBlindSelected() }}
            style={{ padding: "6px 12px", borderRadius: "3px", border: "1px solid var(--danger)", background: "transparent", color: "var(--danger)", fontFamily: "inherit", fontSize: "11px", fontWeight: 600, cursor: bulkBusy ? "wait" : "pointer" }}
          >
            Blind Selected
          </button>
          <button
            type="button"
            onClick={() => { void copyEaSyncFromSelection() }}
            style={{ padding: "6px 12px", borderRadius: "3px", border: "1px solid var(--info)", background: "var(--info)", color: "#fff", fontFamily: "inherit", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}
          >
            {panCopyFeedback ?? "Copy for eaSync"}
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
        <input
          id="monitor-search"
          type="text"
          placeholder="Search SKU / title / ASIN..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "3px", padding: "7px 12px", color: "var(--text)", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace", flex: "1", minWidth: "200px", outline: "none" }}
        />

        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {filterButtons.map(({ key, label }) => (
            <button key={key} type="button" onClick={() => setFilter(key)} style={{
              padding: "7px 10px", border: "1px solid var(--border)", borderRadius: "3px", cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", fontWeight: 600, textTransform: "uppercase",
              background: filter === key ? "rgba(0,255,136,0.1)" : "var(--surface)",
              color:      filter === key ? "var(--accent)" : "var(--sub)",
              borderColor: filter === key ? "rgba(0,255,136,0.3)" : "var(--border)",
            }}>
              {label}
            </button>
          ))}
        </div>

        <select
          aria-label="Sort listings"
          value={sortKey}
          onChange={e => setSortKey(e.target.value as MonitorSortKey)}
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "3px",
            padding: "7px 10px",
            color: "var(--text)",
            fontSize: "11px",
            fontFamily: "'JetBrains Mono', monospace",
            cursor: "pointer",
          }}
        >
          <option value="listed_desc">En yeni</option>
          <option value="listed_asc">En eski</option>
          <option value="price_desc">Fiyat ↓</option>
          <option value="price_asc">Fiyat ↑</option>
        </select>

        <button
          type="button"
          disabled={loading}
          onClick={() => { void load() }}
          style={{
            padding: "7px 14px",
            border: "1px solid var(--border)",
            borderRadius: "3px",
            background: "var(--surface)",
            color: "var(--sub)",
            fontSize: "11px",
            fontFamily: "'JetBrains Mono', monospace",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.75 : 1,
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          {loading ? <Spinner size="sm" /> : null}
          ↻ Refresh
        </button>
      </div>

      {!loading && items.length > 0 && (
        <div style={{ marginBottom: "12px", display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => {
              if (selectMode) {
                setSelectMode(false)
                setSelectedSkus(new Set())
              } else {
                setSelectMode(true)
              }
            }}
            style={{
              padding: "8px 14px",
              borderRadius: "3px",
              border: "1px solid var(--info)",
              background: "var(--info)",
              color: "#fff",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {selectMode ? "✕ Iptal" : "Copy for eaSync"}
          </button>
          <button
            type="button"
            disabled={selectedSkus.size === 0}
            onClick={() => { void copyEaSyncFromSelection() }}
            style={{
              padding: "8px 14px",
              borderRadius: "3px",
              border: "1px solid var(--border)",
              background: selectedSkus.size === 0 ? "var(--bg)" : "var(--surface)",
              color: selectedSkus.size === 0 ? "var(--dim)" : "var(--text)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              fontWeight: 600,
              cursor: selectedSkus.size === 0 ? "not-allowed" : "pointer",
            }}
          >
            {panCopyFeedback ?? "Panoya Kopyala"}
          </button>
        </div>
      )}

      {loading ? (
        <div
          style={{
            padding: "64px 24px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "16px",
            color: "var(--dim)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "12px",
          }}
        >
          <Spinner />
          <span>Loading…</span>
        </div>
      ) : displayItems.length === 0 ? (
        <div style={{ padding: "48px", textAlign: "center", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>
          {items.length === 0 ? "No listings found for this store" : "No results match your filter"}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "12px" }}>
          {displayItems.map(item => {
            const sku = item.sku?.trim() || ""
            return (
              <ProductCard
                key={item.sku}
                item={item}
                onEdit={setEditItem}
                onBlind={handleBlind}
                onSync={handleSyncOne}
                onDetail={setDetailItem}
                selectMode={selectMode}
                selected={Boolean(sku && selectedSkus.has(sku))}
                onToggleSelect={toggleSelectedSku}
              />
            )
          })}
        </div>
      )}

      <div style={{ marginTop: "12px", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "var(--dim)" }}>
        {displayItems.length} of {items.length} on this page · {stats.ebayInventoryTotal} eBay inventory records{stats.sim ? " · simulation mode" : ""}
      </div>

      {!loading && totalPages > 1 && (
        <div
          style={{
            marginTop: "16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "16px",
            flexWrap: "wrap",
            padding: "12px 16px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "12px",
            color: "var(--sub)",
          }}
        >
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            style={{
              padding: "6px 12px",
              borderRadius: "3px",
              border: "1px solid var(--border)",
              background: currentPage <= 1 ? "var(--bg)" : "var(--surface)",
              color: currentPage <= 1 ? "var(--dim)" : "var(--text)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              cursor: currentPage <= 1 ? "not-allowed" : "pointer",
            }}
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
            style={{
              padding: "6px 12px",
              borderRadius: "3px",
              border: "1px solid var(--border)",
              background: currentPage >= totalPages ? "var(--bg)" : "var(--surface)",
              color: currentPage >= totalPages ? "var(--dim)" : "var(--text)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              cursor: currentPage >= totalPages ? "not-allowed" : "pointer",
            }}
          >
            Next →
          </button>
        </div>
      )}

      {typeof document !== "undefined" &&
        editItem &&
        createPortal(
          <EditModal
            item={editItem}
            onClose={() => setEditItem(null)}
            onSave={(fields) => handleSave(editItem, fields)}
            showToast={showToast}
          />,
          document.body
        )}

      {typeof document !== "undefined" &&
        detailItem &&
        createPortal(
          <DetailDrawer
            item={detailItem}
            lastFetchAt={lastFetchAt}
            onClose={() => setDetailItem(null)}
            onSync={async () => {
              setDrawerBusy(true)
              try {
                const ok = await load()
                if (ok) showToast("List refreshed", "success")
              } finally {
                setDrawerBusy(false)
              }
            }}
            onBlind={() => { void handleBlind(detailItem) }}
            onUnblind={() => {
              const row = detailItem
              setDetailItem(null)
              setEditItem(row)
            }}
            onRetry={async () => {
              setDrawerBusy(true)
              try {
                const ok = await load()
                if (ok) showToast("Retry: list refreshed", "success")
              } finally {
                setDrawerBusy(false)
              }
            }}
            busy={drawerBusy}
          />,
          document.body
        )}
    </div>
  )
}
