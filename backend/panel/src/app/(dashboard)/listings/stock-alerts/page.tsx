"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useStore } from "@/lib/storeContext"
import { useToast } from "@/lib/toastContext"
import { getStores, getStockAlerts, postStockAlertsApproveZero, postStockAlertsIgnore, postMonitorUpdateStock, postListingsStockGuard } from "@/lib/api"
import type { StoreRow, StockAlertRow, StockReviewStatus } from "@/lib/api"
import { formatSourceCheckedAgo } from "@/lib/listingsUtils"
import { formatSourceStatusReasonForUi, formatStockAlertStatusLabel, formatVerificationSourceLabel, isUiTurkish } from "@/lib/sourceStatusDisplay"
import {
  UpdateSourceAsinModal,
  type UpdateSourceAsinTarget,
} from "@/components/listings/UpdateSourceAsinModal"
import {
  UpdateEbayPriceModal,
  type UpdateEbayPriceTarget,
} from "@/components/listings/UpdateEbayPriceModal"

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
}

const actionBtnStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  padding: "4px 6px",
  border: "1px solid var(--border)",
  borderRadius: 3,
  background: "var(--bg)",
  color: "var(--sub)",
  cursor: "pointer",
  fontSize: 9,
}

const tdStyle: React.CSSProperties = {
  ...mono,
  padding: "8px 10px",
  color: "var(--text)",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "middle",
}

function formatMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `$${n.toFixed(2)}`
}

function amazonUrl(asin: string): string {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}`
}

function ebayUrl(itemId: string): string {
  return `https://www.ebay.com/itm/${encodeURIComponent(itemId)}`
}

export default function StockAlertsPage() {
  const { selectedStore, setSelectedStore, isStoreReady } = useStore()
  const { showToast } = useToast()

  const [stores, setStores] = useState<StoreRow[]>([])
  const [rows, setRows] = useState<StockAlertRow[]>([])
  const [summary, setSummary] = useState({
    pending: 0,
    processing: 0,
    noPrice: 0,
    unavailable: 0,
    removed: 0,
    priceIncrease: 0,
  })
  const [status, setStatus] = useState<StockReviewStatus>("pending")
  const [risk, setRisk] = useState<"all" | "NO_PRICE" | "UNAVAILABLE" | "REMOVED" | "PRICE_INCREASE">("all")
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [sourceAsinModalOpen, setSourceAsinModalOpen] = useState(false)
  const [sourceAsinTarget, setSourceAsinTarget] = useState<UpdateSourceAsinTarget | null>(null)
  const [ebayPriceModalOpen, setEbayPriceModalOpen] = useState(false)
  const [ebayPriceTarget, setEbayPriceTarget] = useState<UpdateEbayPriceTarget | null>(null)
  const tr = isUiTurkish()

  const selectedStoreRef = useRef(selectedStore)
  useEffect(() => {
    selectedStoreRef.current = selectedStore
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
      setSelectedStore(list[0]!.storeCode)
    }
  }, [stores, selectedStore, setSelectedStore])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [selectedStore, status, risk, search])

  const storeOptions = useMemo(() => {
    const active = stores.filter(s => s.status === "active")
    return active.length > 0 ? active : stores
  }, [stores])

  const selectableRows = useMemo(
    () => rows.filter(r => r.reviewStatus === "pending"),
    [rows]
  )

  const allVisibleSelected =
    selectableRows.length > 0 && selectableRows.every(r => selectedIds.has(r.id))

  const load = useCallback(
    async (opts?: { keepSelection?: boolean }) => {
      if (!isStoreReady || !selectedStore) return
      setLoading(true)
      const storeCode = selectedStore
      try {
        const res = await getStockAlerts({
          storeCode,
          status,
          risk,
          search,
          limit: 200,
          offset: 0,
        })
        if (storeCode !== selectedStoreRef.current) return
        setRows(res.rows ?? [])
        setSummary(
          res.summary ?? {
            pending: 0,
            processing: 0,
            noPrice: 0,
            unavailable: 0,
            removed: 0,
            priceIncrease: 0,
          }
        )
        if (!opts?.keepSelection) setSelectedIds(new Set())
      } catch (e) {
        if (storeCode !== selectedStoreRef.current) return
        showToast(e instanceof Error ? e.message : "Failed to load stock alerts", "error")
        setRows([])
      } finally {
        if (storeCode === selectedStoreRef.current) setLoading(false)
      }
    },
    [isStoreReady, selectedStore, status, risk, search, showToast]
  )

  useEffect(() => {
    void load()
  }, [load])

  const hasProcessing = summary.processing > 0 || rows.some(r => r.reviewStatus === "processing")

  useEffect(() => {
    if (!hasProcessing) return
    const t = setInterval(() => {
      void load({ keepSelection: true })
    }, 3000)
    return () => clearInterval(t)
  }, [hasProcessing, load])

  function toggleId(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAllVisible() {
    if (allVisibleSelected) {
      setSelectedIds(new Set())
      return
    }
    setSelectedIds(new Set(selectableRows.map(r => r.id)))
  }

  async function ignoreSelected() {
    if (selectedIds.size === 0) return
    await ignoreIds([...selectedIds])
  }

  function openEbayPriceModal(r: StockAlertRow) {
    setEbayPriceTarget({
      catalogStateId: r.catalogStateId,
      currentEbayPrice: r.ebayPrice,
      amazonPrice: r.newSourcePrice ?? r.sourcePrice,
      sku: r.internalSku,
    })
    setEbayPriceModalOpen(true)
  }

  async function approveQty1Ids(ids: number[]) {
    if (ids.length === 0) return
    setBusy(true)
    const storeCode = selectedStoreRef.current
    try {
      const targets = rows.filter(r => ids.includes(r.id))
      let ok = 0
      let fail = 0
      for (const row of targets) {
        const sku = row.internalSku?.trim()
        if (!sku) {
          fail++
          continue
        }
        try {
          const res = await postMonitorUpdateStock(storeCode, sku, 1)
          if (res.success && !res.simulation) ok++
          else fail++
        } catch {
          fail++
        }
      }
      if (storeCode !== selectedStoreRef.current) return
      if (ok > 0) {
        await postStockAlertsIgnore(storeCode, ids)
        showToast(
          ok === 1 ? "1 listing set to quantity 1" : `${ok} listings set to quantity 1`,
          "success"
        )
        setSelectedIds(new Set())
        await load()
      } else {
        showToast(fail > 0 ? "Set Qty 1 failed" : "No listings updated", "error")
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Set Qty 1 failed", "error")
    } finally {
      setBusy(false)
    }
  }

  async function stopTrackingIds(ids: number[]) {
    if (ids.length === 0) return
    setBusy(true)
    const storeCode = selectedStoreRef.current
    try {
      const targets = rows.filter(r => ids.includes(r.id))
      const refs = targets
        .map(r => {
          const ebayId = r.ebayItemId?.trim()
          if (ebayId) return { ebayItemId: ebayId }
          if (r.catalogStateId > 0) return { catalogStateId: r.catalogStateId }
          return null
        })
        .filter((ref): ref is { ebayItemId: string } | { catalogStateId: number } => ref != null)
      if (refs.length === 0) {
        showToast("Selected alerts have no eBay ID or catalog row", "error")
        return
      }
      const guardRes = await postListingsStockGuard(storeCode, refs, false)
      const ignoreRes = await postStockAlertsIgnore(storeCode, ids)
      if (storeCode !== selectedStoreRef.current) return
      showToast(
        `Stopped tracking ${guardRes.updated} listing(s); ignored ${ignoreRes.ignored} alert(s)`,
        guardRes.updated > 0 ? "success" : "error"
      )
      setSelectedIds(new Set())
      await load()
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Stop tracking failed", "error")
    } finally {
      setBusy(false)
    }
  }

  async function approveZeroIds(ids: number[]) {
    if (ids.length === 0) return
    setBusy(true)
    const storeCode = selectedStoreRef.current
    try {
      const res = await postStockAlertsApproveZero(storeCode, ids)
      if (storeCode !== selectedStoreRef.current) return
      const n = res.processing ?? ids.length
      showToast(
        n === 1 ? "1 listing queued for quantity zeroing" : `${n} listings queued for quantity zeroing`,
        "success"
      )
      setSelectedIds(new Set())
      setStatus("processing")
      await load()
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Approve failed", "error")
    } finally {
      setBusy(false)
    }
  }

  async function ignoreIds(ids: number[]) {
    if (ids.length === 0) return
    setBusy(true)
    const storeCode = selectedStoreRef.current
    try {
      const res = await postStockAlertsIgnore(storeCode, ids)
      if (storeCode !== selectedStoreRef.current) return
      showToast(`Ignored ${res.ignored} item(s)`, "success")
      setSelectedIds(new Set())
      await load()
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Ignore failed", "error")
    } finally {
      setBusy(false)
    }
  }

  async function approveQty1Selected() {
    if (selectedIds.size === 0) return
    await approveQty1Ids([...selectedIds])
  }

  async function stopTrackingSelected() {
    if (selectedIds.size === 0) return
    await stopTrackingIds([...selectedIds])
  }

  async function approveZeroSelected() {
    if (selectedIds.size === 0) return
    await approveZeroIds([...selectedIds])
  }

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

  const showBulkActions = status === "pending"

  return (
    <div style={{ maxWidth: "100%", animation: "fade-in 0.3s ease forwards" }}>
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
          {!isStoreReady || storeOptions.length === 0 ? <option value="">Loading stores…</option> : null}
          {storeOptions.map(s => (
            <option key={s.storeCode} value={s.storeCode}>
              {s.name?.trim() || s.storeCode}
            </option>
          ))}
        </select>

        <select
          aria-label="Status"
          value={status}
          onChange={e => setStatus(e.target.value as StockReviewStatus)}
          style={selectStyle}
          disabled={loading || busy}
        >
          <option value="pending">Pending ({summary.pending})</option>
          <option value="processing">Processing ({summary.processing})</option>
          <option value="actioned">Actioned</option>
          <option value="ignored">Ignored</option>
          <option value="failed">Failed</option>
        </select>

        <select
          aria-label="Risk"
          value={risk}
          onChange={e => setRisk(e.target.value as typeof risk)}
          style={selectStyle}
          disabled={loading || busy}
        >
          <option value="all">All risks</option>
          <option value="NO_PRICE">No Price</option>
          <option value="UNAVAILABLE">Unavailable</option>
          <option value="REMOVED">Removed</option>
          <option value="PRICE_INCREASE">Price Increase ({summary.priceIncrease})</option>
        </select>

        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search title / ASIN / eBay ID"
          style={{ ...selectStyle, minWidth: 260 }}
        />

        {showBulkActions && selectedIds.size > 0 ? (
          <span style={{ ...mono, color: "var(--accent)", fontWeight: 700 }}>
            {selectedIds.size} selected
          </span>
        ) : null}

        {showBulkActions ? (
          <>
            <button
              type="button"
              disabled={busy || selectedIds.size === 0}
              onClick={() => void approveZeroSelected()}
              style={{
                ...mono,
                padding: "8px 14px",
                borderRadius: "3px",
                border: "none",
                background: selectedIds.size > 0 ? "var(--danger)" : "var(--bg)",
                color: selectedIds.size > 0 ? "#000" : "var(--dim)",
                fontWeight: 700,
                cursor: busy ? "wait" : "pointer",
                marginLeft: showBulkActions && selectedIds.size === 0 ? "auto" : undefined,
                opacity: busy ? 0.7 : 1,
              }}
            >
              Approve selected → Qty 0
            </button>

            <button
              type="button"
              disabled={busy || selectedIds.size === 0}
              onClick={() => void approveQty1Selected()}
              style={{
                ...mono,
                padding: "8px 14px",
                borderRadius: "3px",
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--sub)",
                fontWeight: 700,
                cursor: busy ? "wait" : "pointer",
                opacity: busy ? 0.7 : 1,
              }}
            >
              {tr ? "Seçililer → Stok 1" : "Approve selected → Qty 1"}
            </button>

            <button
              type="button"
              disabled={busy || selectedIds.size === 0}
              onClick={() => void stopTrackingSelected()}
              style={{
                ...mono,
                padding: "8px 14px",
                borderRadius: "3px",
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--sub)",
                fontWeight: 700,
                cursor: busy ? "wait" : "pointer",
                opacity: busy ? 0.7 : 1,
              }}
            >
              {tr ? "Takibi Bırak" : "Stop Tracking"}
            </button>

            <button
              type="button"
              disabled={busy || selectedIds.size === 0}
              onClick={() => void ignoreSelected()}
              style={{
                ...mono,
                padding: "8px 14px",
                borderRadius: "3px",
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--sub)",
                fontWeight: 700,
                cursor: busy ? "wait" : "pointer",
                marginLeft: selectedIds.size > 0 ? undefined : "auto",
                opacity: busy ? 0.7 : 1,
              }}
            >
              Ignore selected
            </button>
          </>
        ) : null}
      </div>

      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "4px", background: "var(--surface)" }}>
        {loading ? (
          <div style={{ padding: "48px", color: "var(--dim)", ...mono }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "48px", color: "var(--dim)", ...mono }}>No alerts</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1200 }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: 36 }}>
                  {showBulkActions && selectableRows.length > 0 ? (
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAllVisible}
                      title="Select all visible pending items"
                      style={{ accentColor: "var(--accent)" }}
                    />
                  ) : null}
                </th>
                <th style={{ ...thStyle, width: 52 }}>Img</th>
                <th style={thStyle}>Title</th>
                <th style={thStyle}>ASIN</th>
                <th style={thStyle}>eBay ID</th>
                <th style={thStyle}>Qty</th>
                <th style={thStyle}>eBay Price</th>
                <th style={thStyle}>Amazon Price</th>
                <th style={thStyle}>Old Amz</th>
                <th style={thStyle}>New Amz</th>
                <th style={thStyle}>Source Status</th>
                <th style={thStyle}>Reason</th>
                <th style={thStyle}>Checked</th>
                <th style={{ ...thStyle, minWidth: 200 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const selected = selectedIds.has(r.id)
                const isPending = r.reviewStatus === "pending"
                const isProcessing = r.reviewStatus === "processing"
                const checkboxDisabled = !isPending || busy
                const reasonDisplay = formatSourceStatusReasonForUi(r.sourceStatus, r.sourceStatusReason)

                return (
                  <tr
                    key={r.id}
                    style={{
                      background: isProcessing
                        ? "rgba(255,200,0,0.06)"
                        : selected
                          ? "rgba(0,255,136,0.04)"
                          : "transparent",
                      opacity: isProcessing ? 0.85 : 1,
                    }}
                  >
                    <td style={tdStyle}>
                      {showBulkActions && (isPending || isProcessing) ? (
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={checkboxDisabled}
                          onChange={() => toggleId(r.id)}
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
                        {r.imageUrl ? (
                          <img src={r.imageUrl} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                        ) : (
                          <span style={{ opacity: 0.3, fontSize: 14 }}>📦</span>
                        )}
                      </div>
                    </td>
                    <td style={{ ...tdStyle, maxWidth: 260 }}>
                      <span title={r.ebayTitle ?? "—"} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.ebayTitle ?? "—"}
                      </span>
                      {isProcessing ? (
                        <span style={{ fontSize: 9, color: "var(--warn)", marginTop: 2, display: "block" }}>
                          Processing…
                        </span>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      <a href={amazonUrl(r.asin)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--info)", textDecoration: "underline" }}>
                        {r.asin}
                      </a>
                    </td>
                    <td style={tdStyle}>
                      {r.ebayItemId ? (
                        <a href={ebayUrl(r.ebayItemId)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--sub)", textDecoration: "underline" }}>
                          {r.ebayItemId}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={tdStyle}>{r.ebayQuantity ?? "—"}</td>
                    <td style={tdStyle}>{formatMoney(r.ebayPrice)}</td>
                    <td style={tdStyle}>
                      <div title={reasonDisplay !== "—" ? reasonDisplay : undefined}>{formatMoney(r.sourcePrice)}</div>
                      {r.checkedAt ? (
                        <div style={{ fontSize: 9, color: "var(--dim)", marginTop: 2 }}>
                          {formatSourceCheckedAgo(r.checkedAt)}
                        </div>
                      ) : null}
                    </td>
                    <td style={tdStyle}>{formatMoney(r.oldSourcePrice)}</td>
                    <td style={tdStyle}>{formatMoney(r.newSourcePrice)}</td>
                    <td style={tdStyle}>
                      {formatStockAlertStatusLabel({
                        sourceStatus: r.sourceStatus,
                        reviewStatus: r.reviewStatus,
                        reason: r.sourceStatusReason,
                      })}
                    </td>
                    <td style={{ ...tdStyle, maxWidth: 280 }}>
                      <span title={reasonDisplay} style={{ color: "var(--dim)" }}>
                        {reasonDisplay}
                      </span>
                      <div style={{ color: "var(--dim)", fontSize: 9, marginTop: 2 }}>Karar kaynağı: {formatVerificationSourceLabel(r.verificationSource)}</div>
                      {r.sourceStatus === "PRICE_INCREASE" ||
                      r.recommendedEbayPrice != null ||
                      r.storeMarkupPercent != null ? (
                        <div style={{ fontSize: 9, color: "var(--sub)", marginTop: 4, lineHeight: 1.4 }}>
                          {r.ebayPrice != null ? (
                            <div>
                              {tr ? "eBay" : "eBay"}: {formatMoney(r.ebayPrice)}
                            </div>
                          ) : null}
                          {r.oldSourcePrice != null || r.newSourcePrice != null ? (
                            <div>
                              {tr ? "Amazon" : "Amazon"}: {formatMoney(r.oldSourcePrice)} → {formatMoney(r.newSourcePrice)}
                            </div>
                          ) : null}
                          {r.storeMarkupPercent != null ? (
                            <div>
                              {tr ? "Markup" : "Markup"}: {r.storeMarkupPercent}%
                            </div>
                          ) : null}
                          {r.recommendedEbayPrice != null ? (
                            <div>
                              {tr ? "Önerilen eBay" : "Recommended eBay"}: {formatMoney(r.recommendedEbayPrice)}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      {r.checkedAt ? new Date(r.checkedAt).toLocaleString() : "—"}
                      {r.reviewStatus === "failed" && r.actionError ? (
                        <div style={{ fontSize: 9, color: "var(--danger)", marginTop: 2 }} title={r.actionError}>
                          {r.actionError}
                        </div>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      {isPending ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          <button
                            type="button"
                            disabled={busy}
                            title={tr ? "eBay Fiyatını Güncelle" : "Update eBay Price"}
                            onClick={() => openEbayPriceModal(r)}
                            style={actionBtnStyle}
                          >
                            {tr ? "Fiyat" : "Price"}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            title={tr ? "Stok 0" : "Set Qty 0"}
                            onClick={() => void approveZeroIds([r.id])}
                            style={actionBtnStyle}
                          >
                            Qty 0
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            title={tr ? "Stok 1" : "Set Qty 1"}
                            onClick={() => void approveQty1Ids([r.id])}
                            style={actionBtnStyle}
                          >
                            Qty 1
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            title={tr ? "Takibi Bırak" : "Stop Tracking"}
                            onClick={() => void stopTrackingIds([r.id])}
                            style={actionBtnStyle}
                          >
                            {tr ? "Bırak" : "Stop"}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            title="Ignore"
                            onClick={() => void ignoreIds([r.id])}
                            style={actionBtnStyle}
                          >
                            {tr ? "Yoksay" : "Ignore"}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            title={tr ? "Kaynak ASIN Güncelle" : "Update Source ASIN"}
                            onClick={() => {
                              setSourceAsinTarget({
                                catalogStateId: r.catalogStateId,
                                currentAsin: r.asin,
                                sku: r.internalSku,
                              })
                              setSourceAsinModalOpen(true)
                            }}
                            style={actionBtnStyle}
                          >
                            ASIN
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          title={tr ? "eBay Fiyatını Güncelle" : "Update eBay Price"}
                          onClick={() => openEbayPriceModal(r)}
                          style={actionBtnStyle}
                        >
                          {tr ? "Fiyat" : "Price"}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <UpdateSourceAsinModal
        open={sourceAsinModalOpen}
        storeCode={selectedStore}
        target={sourceAsinTarget}
        onClose={() => {
          setSourceAsinModalOpen(false)
          setSourceAsinTarget(null)
        }}
        onSaved={() => {
          showToast(tr ? "Kaynak ASIN güncellendi." : "Source ASIN updated.", "success")
          void load()
        }}
      />

      <UpdateEbayPriceModal
        open={ebayPriceModalOpen}
        storeCode={selectedStore}
        target={ebayPriceTarget}
        onClose={() => {
          setEbayPriceModalOpen(false)
          setEbayPriceTarget(null)
        }}
        onSaved={() => {
          showToast(tr ? "eBay fiyatı güncellendi." : "eBay price updated.", "success")
          void load()
        }}
      />
    </div>
  )
}
