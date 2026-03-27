"use client"

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { createPortal } from "react-dom"
import { getMonitorListings, postMonitorUpdatePrice, postMonitorUpdateStock, postMonitorBlind } from "@/lib/api"
import type { MonitorItem } from "@/lib/api"
import { useStore } from "@/lib/storeContext"

// ─── HELPERS ──────────────────────────────────────────────────

function usd(n: number | null): string {
  if (n === null) return "—"
  return `$${n.toFixed(2)}`
}

function pct(n: number | null): string {
  if (n === null) return "—"
  const color = n >= 20 ? "var(--accent)" : n >= 10 ? "var(--warn)" : "var(--danger)"
  return `${n.toFixed(1)}%`
}

function marginColor(n: number | null): string {
  if (n === null) return "var(--dim)"
  if (n >= 20) return "var(--accent)"
  if (n >= 10) return "var(--warn)"
  return "var(--danger)"
}

function TrackedBadge({ status }: { status: MonitorItem["status"] }) {
  const tracked = status === "TRACKED"
  return (
    <span style={{
      padding: "2px 8px", borderRadius: "20px", fontSize: "10px", fontWeight: 700,
      fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase",
      background: tracked ? "rgba(0,255,136,0.12)" : "rgba(136,136,136,0.12)",
      color:      tracked ? "var(--accent)"        : "var(--dim)",
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

// ─── EDIT MODAL ───────────────────────────────────────────────

type EditFields = { stock: number; cost: number; ebayPrice: number }

function EditModal({ item, onClose, onSave }: { item: MonitorItem; onClose: () => void; onSave: (fields: EditFields) => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  const [fields, setFields] = useState<EditFields>({
    stock:     item.quantity,
    cost:      item.cost ?? 0,
    ebayPrice: item.ebayPrice,
  })

  const calcMargin = fields.ebayPrice > 0
    ? ((fields.ebayPrice - fields.cost) / fields.ebayPrice * 100).toFixed(1)
    : "0"

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
          <span style={{ color: marginColor(parseFloat(calcMargin)), fontWeight: 700 }}>{calcMargin}%</span>
        </div>

        <div style={{ display: "flex", gap: "10px" }}>
          <button
            onClick={async () => {
              setSaving(true)
              try {
                await onSave(fields)
                onClose()
              } catch {
                /* kullanıcıya gösterme */
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

// ─── PRODUCT CARD ─────────────────────────────────────────────

type MonitorSortKey = "listed_desc" | "listed_asc" | "price_desc" | "price_asc"

function ProductCard({ item, onEdit, onBlind, selectMode, selected, onToggleSelect }: {
  item:           MonitorItem
  onEdit:         (item: MonitorItem) => void
  onBlind:        (item: MonitorItem) => void
  selectMode:     boolean
  selected:       boolean
  onToggleSelect: (ebayItemId: string) => void
}) {
  const ebayId = item.ebayItemId?.trim()
  const showCb = selectMode && Boolean(ebayId)

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
      {showCb && ebayId && (
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
            onChange={() => onToggleSelect(ebayId)}
            style={{ width: "16px", height: "16px", cursor: "pointer", accentColor: "var(--accent)" }}
          />
        </label>
      )}
      {/* Image */}
      <div style={{ height: "130px", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", borderBottom: "1px solid var(--border)", overflow: "hidden", position: "relative", zIndex: 0 }}>
        {item.image
          ? <img src={item.image} alt={item.title} style={{ maxHeight: "110px", maxWidth: "100%", objectFit: "contain" }} onError={e => { (e.target as HTMLImageElement).style.display = "none" }} />
          : <span style={{ fontSize: "28px", opacity: 0.2 }}>📦</span>
        }
      </div>

      {/* Content */}
      <div style={{ padding: "12px", flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
          <p style={{ fontSize: "12px", color: "var(--text)", lineHeight: "1.4", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>
            {item.title || "—"}
          </p>
          <TrackedBadge status={item.status} />
        </div>

        <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color: "var(--dim)" }}>
          {item.sku}
        </p>

        {item.asin && (
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color: "var(--info)" }}>
            {item.asin}
          </p>
        )}

        {item.ebayItemId ? (
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "9px", color: "var(--dim)", marginTop: "2px" }}>
            eBay: {item.ebayItemId}
          </p>
        ) : null}

        {/* Price grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", marginTop: "4px" }}>
          {[
            { label: "Price",  value: usd(item.ebayPrice), color: "var(--text)"   },
            { label: "Cost",   value: usd(item.cost),      color: "var(--sub)"    },
            { label: "Margin", value: pct(item.margin),    color: marginColor(item.margin) },
            { label: "Qty",    value: String(item.quantity), color: item.quantity > 0 ? "var(--text)" : "var(--danger)" },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ padding: "6px 8px", background: "var(--bg)", borderRadius: "3px" }}>
              <p style={{ fontSize: "9px", letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>{label}</p>
              <p style={{ fontSize: "13px", fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace", marginTop: "2px" }}>{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", borderTop: "1px solid var(--border)" }}>
        <button
          onClick={() => onBlind(item)}
          style={{ flex: 1, padding: "8px", border: "none", cursor: "pointer", background: "transparent", color: "var(--danger)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", fontWeight: 600, borderRight: "1px solid var(--border)" }}
        >
          Blind
        </button>
        <button
          onClick={() => onEdit(item)}
          style={{ flex: 1, padding: "8px", border: "none", cursor: "pointer", background: "transparent", color: "var(--sub)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", fontWeight: 600 }}
        >
          Edit
        </button>
      </div>
    </div>
  )
}

// ─── MAIN PAGE ────────────────────────────────────────────────

export default function MonitorPage() {
  const { selectedStore } = useStore()
  const [items,     setItems]     = useState<MonitorItem[]>([])
  const [stats,     setStats]     = useState({
    ebayInventoryTotal: 0,
    tracked:            0,
    untracked:          0,
    sim:                true,
  })
  const [totalPages, setTotalPages] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(50)
  const [loading,   setLoading]   = useState(true)
  const [search,    setSearch]    = useState("")
  const [filter,    setFilter]    = useState<"all" | "TRACKED" | "UNTRACKED">("all")
  const [editItem,  setEditItem]  = useState<MonitorItem | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedEbayIds, setSelectedEbayIds] = useState<Set<string>>(() => new Set())
  const [sortKey, setSortKey] = useState<MonitorSortKey>("listed_desc")
  const [panCopyFeedback, setPanCopyFeedback] = useState<string | null>(null)
  const skipScrollRef = useRef(true)

  useEffect(() => {
    setCurrentPage(1)
    setSelectMode(false)
    setSelectedEbayIds(new Set())
  }, [selectedStore])

  // Load listings
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getMonitorListings(selectedStore, {
        offset: (currentPage - 1) * pageSize,
        limit:  pageSize,
      })
      setItems(res.items)
      setStats({
        ebayInventoryTotal: typeof res.ebayInventoryTotal === "number" ? res.ebayInventoryTotal : 0,
        tracked:            res.tracked,
        untracked:          res.untracked,
        sim:                res.simulationMode,
      })
      const tp = Math.max(1, res.totalPages)
      setTotalPages(tp)
      setCurrentPage(cp => Math.min(cp, tp))
    } catch {
      setItems([])
      setStats({ ebayInventoryTotal: 0, tracked: 0, untracked: 0, sim: false })
      setTotalPages(1)
    } finally {
      setLoading(false)
    }
  }, [selectedStore, currentPage, pageSize])

  useEffect(() => { load() }, [load])

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
    } catch {
      /* sessiz */
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

    const newMargin = fields.ebayPrice > 0 && fields.cost > 0
      ? Math.round(((fields.ebayPrice - fields.cost) / fields.ebayPrice) * 100 * 100) / 100
      : null

    setItems(prev => prev.map(i => i.sku === item.sku
      ? { ...i, ebayPrice: fields.ebayPrice, quantity: fields.stock, margin: newMargin }
      : i
    ))
  }

  // Filter
  const filtered = items.filter(item => {
    if (filter !== "all" && item.status !== filter) return false
    if (search) {
      const q = search.toLowerCase()
      return item.sku.toLowerCase().includes(q) ||
             item.title.toLowerCase().includes(q) ||
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
        arr.sort((a, b) => b.ebayPrice - a.ebayPrice || a.sku.localeCompare(b.sku))
        break
      case "price_asc":
        arr.sort((a, b) => a.ebayPrice - b.ebayPrice || a.sku.localeCompare(b.sku))
        break
      default:
        break
    }
    return arr
  }, [filtered, sortKey])

  function toggleSelectedEbayId(id: string) {
    setSelectedEbayIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div style={{ maxWidth: "1200px", animation: "fade-in 0.3s ease forwards" }}>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px", marginBottom: "20px" }}>
        {[
          { label: "Total",      value: stats.ebayInventoryTotal, color: "var(--text)"   },
          { label: "Tracked",    value: stats.tracked,              color: "var(--accent)" },
          { label: "Untracked",  value: stats.untracked,            color: "var(--dim)"    },
          { label: "Mode",       value: stats.sim ? "SIM" : "LIVE", color: stats.sim ? "var(--warn)" : "var(--accent)" },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ padding: "12px 16px", background: "var(--surface)", border: "1px solid var(--border)", borderTop: `2px solid ${color}`, borderRadius: "3px" }}>
            <p style={{ fontSize: "10px", letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>{label}</p>
            <p style={{ fontSize: "22px", fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace", marginTop: "4px" }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
        <input
          id="monitor-search"
          type="text"
          placeholder="Search SKU / title / ASIN..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "3px", padding: "7px 12px", color: "var(--text)", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace", flex: "1", minWidth: "200px", outline: "none" }}
        />

        <div style={{ display: "flex", gap: "6px" }}>
          {(["all", "TRACKED", "UNTRACKED"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "3px", cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", fontWeight: 600, textTransform: "uppercase",
              background: filter === f ? "rgba(0,255,136,0.1)" : "var(--surface)",
              color:      filter === f ? "var(--accent)" : "var(--sub)",
              borderColor: filter === f ? "rgba(0,255,136,0.3)" : "var(--border)",
            }}>
              {f === "all" ? "All" : f}
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
                setSelectedEbayIds(new Set())
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
            {selectMode ? "✕ İptal" : "Copy for eaSync"}
          </button>
          <button
            type="button"
            disabled={selectedEbayIds.size === 0}
            onClick={async () => {
              const rows = displayItems
                .filter(i => {
                  const id = i.ebayItemId?.trim()
                  return id && selectedEbayIds.has(id) && i.asin?.trim()
                })
                .map(i => `${i.ebayItemId!.trim()},${i.asin!.trim()}`)
              const text = ["ebay_item_id,product_id", ...rows].join("\n")
              try {
                await navigator.clipboard.writeText(text)
                setPanCopyFeedback("✓ Copied!")
                window.setTimeout(() => setPanCopyFeedback(null), 2000)
              } catch {
                /* sessiz */
              }
            }}
            style={{
              padding: "8px 14px",
              borderRadius: "3px",
              border: "1px solid var(--border)",
              background: selectedEbayIds.size === 0 ? "var(--bg)" : "var(--surface)",
              color: selectedEbayIds.size === 0 ? "var(--dim)" : "var(--text)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              fontWeight: 600,
              cursor: selectedEbayIds.size === 0 ? "not-allowed" : "pointer",
            }}
          >
            {panCopyFeedback ?? "📋 Panoya Kopyala"}
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
            const id = item.ebayItemId?.trim()
            return (
              <ProductCard
                key={item.sku}
                item={item}
                onEdit={setEditItem}
                onBlind={handleBlind}
                selectMode={selectMode}
                selected={Boolean(id && selectedEbayIds.has(id))}
                onToggleSelect={toggleSelectedEbayId}
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
          <EditModal item={editItem} onClose={() => setEditItem(null)} onSave={(fields) => handleSave(editItem, fields)} />,
          document.body
        )}
    </div>
  )
}
