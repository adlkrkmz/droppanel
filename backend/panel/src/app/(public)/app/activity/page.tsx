"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { useRouter } from "next/navigation"
import { fetchAuthMe, type UserPublic } from "@/lib/userAuthClient"
import {
  fetchAppActivity,
  fetchAppStores,
  type AppActivityActionFilter,
  type AppActivityItem,
  type AppStoreSummary,
} from "@/lib/userAppClient"
import { formatBulkBatchRef } from "@/lib/bulkActionsUi"
import { AppEmptyState } from "@/components/app/AppEmptyState"
import { AppHelpBox } from "@/components/app/AppHelpBox"
import { useFocusRefetch } from "@/components/app/useFocusRefetch"
import {
  adoptStoreSelection,
  storeCodeForId,
  useAppStoreSelection,
} from "@/lib/appStoreSelection"

const PAGE_LIMIT = 50

const ACTION_FILTER_OPTIONS: { value: AppActivityActionFilter; label: string }[] = [
  { value: "all",          label: "All actions" },
  { value: "bulk",         label: "Bulk actions" },
  { value: "listings",     label: "Listings" },
  { value: "stock-alerts", label: "Stock alerts" },
  { value: "stock-guard",  label: "Stock Guard" },
  { value: "settings",     label: "Settings" },
  { value: "ebay",         label: "eBay" },
  { value: "failed",       label: "Failed only" },
]

function fmtDate(s: string | null | undefined): string {
  if (!s?.trim()) return "—"
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString()
}

function formatTarget(item: AppActivityItem): string {
  if (item.batchId) return formatBulkBatchRef(item.batchId) || item.targetId || "—"
  if (item.targetId?.trim()) return item.targetId
  if (item.metadataPreview.catalogStateId != null) {
    return `#${String(item.metadataPreview.catalogStateId)}`
  }
  if (item.metadataPreview.alertId != null) {
    return `Alert ${String(item.metadataPreview.alertId)}`
  }
  return "—"
}

function formatDetails(item: AppActivityItem): string {
  const parts: string[] = []
  const preview = item.metadataPreview

  if (preview.ebayItemId && typeof preview.ebayItemId === "string") {
    parts.push(`eBay ${preview.ebayItemId}`)
  }
  if (preview.asin && typeof preview.asin === "string") {
    parts.push(`ASIN ${preview.asin}`)
  }
  if (preview.previousAsin && preview.newAsin) {
    parts.push(`${preview.previousAsin} → ${preview.newAsin}`)
  }
  if (preview.oldPrice != null && preview.newPrice != null) {
    parts.push(`$${preview.oldPrice} → $${preview.newPrice}`)
  }
  if (preview.enabled != null) {
    parts.push(preview.enabled ? "Guard enabled" : "Guard disabled")
  }
  if (preview.reason && typeof preview.reason === "string") {
    parts.push(preview.reason)
  }
  if (item.requested != null && item.succeeded != null && item.failed != null) {
    parts.push(`Req ${item.requested} · OK ${item.succeeded} · Fail ${item.failed}`)
  }

  return parts.length > 0 ? parts.join(" · ") : "—"
}

function ResultBadge({ result }: { result: AppActivityItem["result"] }) {
  const meta =
    result === "success"
      ? { label: "Success", bg: "rgba(60,180,120,0.15)", color: "#6c9" }
      : result === "partial"
        ? { label: "Partial", bg: "rgba(234, 179, 8, 0.15)", color: "#ca8" }
        : { label: "Failed", bg: "rgba(248, 113, 113, 0.15)", color: "#f87171" }

  return (
    <span
      style={{
        display:      "inline-block",
        fontSize:     10,
        fontWeight:   600,
        padding:      "2px 7px",
        borderRadius: 4,
        background:   meta.bg,
        color:        meta.color,
        whiteSpace:   "nowrap",
      }}
    >
      {meta.label}
    </span>
  )
}

export default function AppActivityPage() {
  const router = useRouter()
  const { selectedStoreId, setSelectedStoreId, isStoreSelectionReady } = useAppStoreSelection()
  const selectedStoreIdRef = useRef(selectedStoreId)
  selectedStoreIdRef.current = selectedStoreId
  const [user, setUser] = useState<UserPublic | null>(null)
  const [stores, setStores] = useState<AppStoreSummary[]>([])
  const [storeCode, setStoreCode] = useState("")
  const [actionFilter, setActionFilter] = useState<AppActivityActionFilter>("all")
  const [searchInput, setSearchInput] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [items, setItems] = useState<AppActivityItem[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [listLoading, setListLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_LIMIT)), [total])
  const hasStores = stores.length > 0
  const hasFilters = actionFilter !== "all" || Boolean(searchQuery) || Boolean(storeCode)

  const loadActivity = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      const silent = opts?.silent === true
      if (!silent) setListLoading(true)
      else setRefreshing(true)
      setError(null)

      const result = await fetchAppActivity({
        storeCode: storeCode || undefined,
        action:    actionFilter,
        q:         searchQuery || undefined,
        page,
        limit:     PAGE_LIMIT,
      })

      if (!silent) setListLoading(false)
      else setRefreshing(false)

      if (!result.ok) {
        if (result.status === 401) {
          router.replace("/app/login")
          return false
        }
        if (result.status === 403 && result.approvalStatus === "pending_approval") {
          router.replace("/pending-approval")
          return false
        }
        setError(result.error ?? "Could not load activity.")
        return false
      }

      setItems(result.data.items)
      setTotal(result.data.total)
      setPage(result.data.page)
      return true
    },
    [storeCode, actionFilter, searchQuery, page, router]
  )

  const init = useCallback(async () => {
    setLoading(true)
    const me = await fetchAuthMe()
    if (!me) {
      router.replace("/app/login")
      return
    }
    setUser(me)

    const storesResult = await fetchAppStores()
    if (!storesResult.ok) {
      setLoading(false)
      setError(storesResult.error ?? "Could not load stores.")
      return
    }

    setStores(storesResult.data.stores)
    const list = storesResult.data.stores
    if (list.length > 0) {
      const adopted = adoptStoreSelection(list, {
        providerStoreId: selectedStoreIdRef.current,
      })
      if (adopted.shouldWriteProvider && adopted.storeId != null) {
        setSelectedStoreId(adopted.storeId)
      }
      // Activity may filter by store; default filter follows global selection.
      setStoreCode(storeCodeForId(list, adopted.storeId))
    }
    setLoading(false)
  }, [router, setSelectedStoreId])

  useEffect(() => {
    if (!isStoreSelectionReady) return
    void init()
  }, [isStoreSelectionReady, init])

  useEffect(() => {
    if (loading) return
    void loadActivity()
  }, [loading, loadActivity])

  useFocusRefetch(() => void loadActivity({ silent: true }), { enabled: !loading })

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault()
    setPage(1)
    setSearchQuery(searchInput.trim())
  }

  function handleStoreChange(storeIdRaw: string) {
    setPage(1)
    if (!storeIdRaw) {
      setStoreCode("")
      return
    }
    const id = Number(storeIdRaw)
    const store = stores.find(s => s.storeId === id)
    if (!store) return
    setSelectedStoreId(id)
    setStoreCode(store.storeCode)
  }

  function handleActionChange(value: AppActivityActionFilter) {
    setActionFilter(value)
    setPage(1)
  }

  if (loading) {
    return (
      <div style={{ padding: 32, textAlign: "center", color: "var(--dim)" }}>
        Loading activity…
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={pageHeaderStyle}>
        <div>
          <h1 style={pageTitleStyle}>Activity</h1>
          <p style={pageSubtitleStyle}>
            Track listing, stock alert, Stock Guard, and bulk actions.
          </p>
        </div>
        <button
          type="button"
          style={toolbarBtnStyle}
          disabled={listLoading || refreshing}
          onClick={() => void loadActivity({ silent: true })}
        >
          {listLoading || refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <AppHelpBox text="Read-only history of actions in your workspace. Sensitive tokens and raw API responses are never shown here." />

      {error && (
        <div style={errorBoxStyle}>
          <p style={{ margin: "0 0 12px" }}>{error}</p>
          <button type="button" onClick={() => void loadActivity()} style={toolbarBtnStyle}>
            Retry
          </button>
        </div>
      )}

      <div style={filtersRowStyle}>
        <label style={filterLabelStyle}>
          Store
          <select
            value={storeCode ? (selectedStoreId != null ? String(selectedStoreId) : "") : ""}
            onChange={e => handleStoreChange(e.target.value)}
            style={selectStyle}
            disabled={!hasStores}
          >
            <option value="">All stores</option>
            {stores.map(store => (
              <option key={store.storeId} value={store.storeId}>
                {store.storeCode} — {store.name}
              </option>
            ))}
          </select>
        </label>

        <label style={filterLabelStyle}>
          Action
          <select
            value={actionFilter}
            onChange={e => handleActionChange(e.target.value as AppActivityActionFilter)}
            style={selectStyle}
          >
            {ACTION_FILTER_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <form onSubmit={handleSearchSubmit} style={{ display: "flex", gap: 8, flex: 1, minWidth: 220 }}>
          <input
            type="search"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search action, target, ASIN, batch…"
            style={searchInputStyle}
            maxLength={100}
          />
          <button type="submit" style={toolbarBtnStyle}>
            Search
          </button>
        </form>
      </div>

      {listLoading && items.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: "var(--dim)" }}>Loading activity…</div>
      ) : total === 0 ? (
        <AppEmptyState
          title={hasFilters ? "No matching activity" : "No activity yet."}
          description={
            hasFilters
              ? "Try a different store, action filter, or search term."
              : "Actions from listings, stock alerts, Stock Guard, and settings will appear here."
          }
          primaryHref={hasFilters ? undefined : "/app/dashboard"}
          primaryLabel={hasFilters ? undefined : "Dashboard"}
          secondaryLinks={
            hasFilters
              ? undefined
              : [
                  { href: "/app/listings", label: "Listings" },
                  { href: "/app/stock-alerts", label: "Stock Alerts" },
                ]
          }
        />
      ) : (
        <>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--dim)" }}>
            {total} event{total === 1 ? "" : "s"}
            {user?.email ? ` · ${user.email}` : ""}
          </p>

          <div style={{ overflowX: "auto", marginBottom: 16 }}>
            <table style={tableStyle}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                  <th style={thStyle}>Time</th>
                  <th style={thStyle}>Action</th>
                  <th style={thStyle}>Store</th>
                  <th style={thStyle}>Target</th>
                  <th style={thStyle}>Result</th>
                  <th style={thStyle}>Details</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={tdStyle}>{fmtDate(item.createdAt)}</td>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 500 }}>{item.label}</div>
                      {item.summary && (
                        <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 4 }}>
                          {item.summary}
                        </div>
                      )}
                    </td>
                    <td style={tdStyle}>{item.storeCode ?? "—"}</td>
                    <td style={{ ...tdStyle, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                      {formatTarget(item)}
                    </td>
                    <td style={tdStyle}>
                      <ResultBadge result={item.result} />
                    </td>
                    <td style={{ ...tdStyle, fontSize: 12, maxWidth: 280 }}>
                      {formatDetails(item)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={paginationRowStyle}>
            <button
              type="button"
              style={toolbarBtnStyle}
              disabled={page <= 1 || listLoading}
              onClick={() => setPage(p => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span style={{ fontSize: 13, color: "var(--dim)" }}>
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              style={toolbarBtnStyle}
              disabled={page >= totalPages || listLoading}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  )
}

const pageHeaderStyle: CSSProperties = {
  display:        "flex",
  justifyContent: "space-between",
  alignItems:     "flex-start",
  gap:            16,
  marginBottom:   20,
}

const pageTitleStyle: CSSProperties = {
  margin:      0,
  fontSize:    28,
  fontWeight:  700,
}

const pageSubtitleStyle: CSSProperties = {
  margin:     "8px 0 0",
  color:      "var(--dim)",
  fontSize:   14,
  maxWidth:   560,
}

const filtersRowStyle: CSSProperties = {
  display:      "flex",
  flexWrap:     "wrap",
  gap:          12,
  marginBottom: 20,
  alignItems:   "flex-end",
}

const filterLabelStyle: CSSProperties = {
  display:       "flex",
  flexDirection: "column",
  gap:           6,
  fontSize:      12,
  color:         "var(--dim)",
}

const selectStyle: CSSProperties = {
  minWidth:     160,
  padding:      "8px 10px",
  borderRadius: 8,
  border:       "1px solid var(--border)",
  background:   "var(--surface)",
  color:        "inherit",
  fontSize:     13,
}

const searchInputStyle: CSSProperties = {
  flex:         1,
  minWidth:     180,
  padding:      "8px 10px",
  borderRadius: 8,
  border:       "1px solid var(--border)",
  background:   "var(--surface)",
  color:        "inherit",
  fontSize:     13,
}

const toolbarBtnStyle: CSSProperties = {
  padding:      "8px 14px",
  borderRadius: 8,
  border:       "1px solid var(--border)",
  background:   "var(--surface)",
  color:        "inherit",
  fontSize:     13,
  cursor:       "pointer",
}

const errorBoxStyle: CSSProperties = {
  padding:      16,
  marginBottom: 16,
  borderRadius: 8,
  border:       "1px solid rgba(248, 113, 113, 0.35)",
  background:   "rgba(248, 113, 113, 0.08)",
}

const tableStyle: CSSProperties = {
  width:           "100%",
  borderCollapse:  "collapse",
  fontSize:        13,
}

const thStyle: CSSProperties = {
  padding:    "10px 12px",
  fontSize:   11,
  fontWeight: 600,
  color:      "var(--dim)",
  whiteSpace: "nowrap",
}

const tdStyle: CSSProperties = {
  padding:    "12px",
  verticalAlign: "top",
}

const paginationRowStyle: CSSProperties = {
  display:        "flex",
  alignItems:     "center",
  justifyContent: "center",
  gap:            16,
  marginBottom:   24,
}
