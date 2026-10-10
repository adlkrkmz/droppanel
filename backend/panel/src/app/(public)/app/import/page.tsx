"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { fetchAuthMe, type UserPublic } from "@/lib/userAuthClient"
import {
  fetchAppImportStatus,
  fetchAppStores,
  importMatchAppListings,
  syncAppListings,
  type AppImportMatchResponse,
  type AppImportStatusResponse,
  type AppListingsSyncResponse,
  type AppStoreSummary,
} from "@/lib/userAppClient"
import {
  buildUserImportMatchErrorCsv,
  downloadCsvFile,
  formatUserImportMatchErrorFilename,
  hasUserImportMatchErrors,
  parseImportText,
  validateImportRows,
  type ImportValidateResult,
} from "@/lib/listingsUtils"
import { NoStoreEmptyState } from "@/components/app/NoStoreEmptyState"
import { AppHelpBox } from "@/components/app/AppHelpBox"
import { checklistPrimaryBtnStyle } from "@/components/app/OnboardingChecklist"
import {
  adoptStoreSelection,
  parseUrlStoreId,
  storeCodeForId,
  useAppStoreSelection,
} from "@/lib/appStoreSelection"

const RUNNING_STATUSES = new Set(["pending", "catalog_running", "metrics_running", "running"])
const POLL_INTERVAL_MS = 4000
const MAX_POLL_ATTEMPTS = 90

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRunningStatus(status: string | null): boolean {
  if (!status) return false
  return RUNNING_STATUSES.has(status.toLowerCase())
}

function formatSyncStatusLabel(status: string | null): string {
  if (!status) return "Not started"
  const s = status.toLowerCase()
  if (s === "ok") return "Completed"
  if (s === "error") return "Failed"
  if (RUNNING_STATUSES.has(s)) return "Running"
  if (s === "idle") return "Waiting"
  return status
}

function fmtDateTime(s: string | null | undefined): string {
  if (!s?.trim()) return "—"
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString()
}

export default function AppImportPage() {
  const router = useRouter()
  const { selectedStoreId, setSelectedStoreId, isStoreSelectionReady } = useAppStoreSelection()
  const selectedStoreIdRef = useRef(selectedStoreId)
  selectedStoreIdRef.current = selectedStoreId
  const [user, setUser] = useState<UserPublic | null>(null)
  const [stores, setStores] = useState<AppStoreSummary[]>([])
  const [storeCode, setStoreCode] = useState("")
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusPolling, setStatusPolling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<AppListingsSyncResponse | null>(null)
  const [importStatus, setImportStatus] = useState<AppImportStatusResponse | null>(null)
  const [asinMatchMode, setAsinMatchMode] = useState(false)
  const pollAbortRef = useRef(0)

  const selectedStore = useMemo(
    () => stores.find(s => s.storeCode === storeCode) ?? null,
    [stores, storeCode]
  )

  const loadStatus = useCallback(
    async (storeId: number): Promise<AppImportStatusResponse | null> => {
      if (!Number.isInteger(storeId) || storeId < 1) return null

      setStatusLoading(true)
      setStatusError(null)

      const result = await fetchAppImportStatus({ storeId })
      setStatusLoading(false)

      if (!result.ok) {
        if (result.status === 401) {
          router.replace("/app/login")
          return null
        }
        if (result.status === 403 && result.approvalStatus === "pending_approval") {
          router.replace("/pending-approval")
          return null
        }
        setStatusError(result.error)
        return null
      }

      setImportStatus(result.data)
      return result.data
    },
    [router]
  )

  const pollStatus = useCallback(
    async (storeId: number) => {
      const pollId = ++pollAbortRef.current
      setStatusPolling(true)

      let status = await loadStatus(storeId)
      if (pollId !== pollAbortRef.current) return

      if (status && isRunningStatus(status.syncStatus)) {
        for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
          await sleep(POLL_INTERVAL_MS)
          if (pollId !== pollAbortRef.current) return

          status = await loadStatus(storeId)
          if (pollId !== pollAbortRef.current) return
          if (!status || !isRunningStatus(status.syncStatus)) break
        }
      }

      if (pollId === pollAbortRef.current) {
        setStatusPolling(false)
      }
    },
    [loadStatus]
  )

  const refreshStores = useCallback(async (): Promise<boolean> => {
    const storesResult = await fetchAppStores()
    if (!storesResult.ok) return false
    setStores(storesResult.data.stores)
    return true
  }, [])

  const refreshSelectedStoreData = useCallback(async () => {
    await refreshStores()
    if (selectedStoreId != null) {
      await loadStatus(selectedStoreId)
    }
  }, [refreshStores, loadStatus, selectedStoreId])

  const pollStatusAndRefresh = useCallback(
    async (storeId: number) => {
      await pollStatus(storeId)
      await refreshSelectedStoreData()
    },
    [pollStatus, refreshSelectedStoreData]
  )

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

    let initialCode = ""
    if (list.length > 0) {
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
      initialCode = storeCodeForId(list, adopted.storeId)
      setStoreCode(initialCode)
      setAsinMatchMode(params.get("mode")?.trim().toLowerCase() === "asin-match")
    }

    setLoading(false)
  }, [router, setSelectedStoreId])

  useEffect(() => {
    if (!isStoreSelectionReady) return
    void init()
  }, [isStoreSelectionReady, init])

  useEffect(() => {
    if (!isStoreSelectionReady || loading || stores.length === 0) return
    if (selectedStoreId == null) return
    const code = storeCodeForId(stores, selectedStoreId)
    if (!code || code === storeCode) return
    setStoreCode(code)
  }, [selectedStoreId, stores, isStoreSelectionReady, loading, storeCode])

  useEffect(() => {
    if (selectedStoreId == null || loading) return
    pollAbortRef.current++
    setStatusPolling(false)
    void loadStatus(selectedStoreId)
  }, [selectedStoreId, loading, loadStatus])

  useEffect(() => {
    return () => {
      pollAbortRef.current++
    }
  }, [])

  useEffect(() => {
    if (loading || !asinMatchMode) return
    const el = document.getElementById("asin-match-section")
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }, [loading, asinMatchMode, storeCode])

  async function handleImport() {
    if (selectedStoreId == null || importing) return

    setImporting(true)
    setError(null)
    setSyncResult(null)

    const result = await syncAppListings(selectedStoreId)
    setImporting(false)

    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      if (result.status === 403 && result.approvalStatus === "pending_approval") {
        router.replace("/pending-approval")
        return
      }
      setError(result.error)
      void loadStatus(selectedStoreId)
      return
    }

    setSyncResult(result.data)
    await refreshSelectedStoreData()
    void pollStatusAndRefresh(selectedStoreId)
  }

  function handleSyncAgain() {
    setSyncResult(null)
    setError(null)
    void handleImport()
  }

  if (loading) {
    return <div style={{ padding: 48, textAlign: "center", color: "var(--dim)" }}>Loading…</div>
  }

  if (!user) return null

  const hasStores = stores.length > 0

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <Link href="/app/dashboard" style={{ color: "var(--dim)", fontSize: 14, textDecoration: "none" }}>
          ← Dashboard
        </Link>
      </div>

      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontFamily: "'Syne', sans-serif", marginBottom: 8, fontSize: 28 }}>
          Import Listings
        </h1>
        {hasStores && (
          <p style={{ color: "var(--dim)", margin: 0, lineHeight: 1.5 }}>
            Import active eBay listings into ListJetGo so we can monitor prices, stock risks, and profit
            protection.
          </p>
        )}
      </div>

      <AppHelpBox text="Import syncs active eBay listings. It updates existing records instead of creating duplicates." />

      {!hasStores ? (
        <NoStoreEmptyState
          title="Connect a store before importing."
          description="Listing import uses your connected eBay account and writes only to your workspace."
          cta="manage-stores"
        />
      ) : (
        <>
          {error && !importing && (
            <div style={errorBoxStyle}>
              <p style={{ margin: "0 0 12px" }}>{error}</p>
              <button type="button" onClick={() => setError(null)} style={ghostBtnStyle}>
                Dismiss
              </button>
            </div>
          )}

          {syncResult && (
            <ImportResultSummary result={syncResult} onSyncAgain={handleSyncAgain} />
          )}

          {selectedStore && (
            <ImportStoreSummary store={selectedStore} importStatus={importStatus} />
          )}

          <ImportStatusCard
            status={importStatus}
            loading={statusLoading}
            polling={statusPolling}
            error={statusError}
            onRefresh={() => {
              if (selectedStoreId != null) void loadStatus(selectedStoreId)
            }}
          />

          {!syncResult && (
            <div style={{ ...cardStyle, marginTop: 16 }}>
              <label htmlFor="import-store-select" style={{ display: "block", fontWeight: 600, marginBottom: 8 }}>
                Store
              </label>
              <select
                id="import-store-select"
                value={selectedStoreId != null ? String(selectedStoreId) : ""}
                onChange={e => {
                  const id = Number(e.target.value)
                  const store = stores.find(s => s.storeId === id)
                  if (!store) return
                  setSelectedStoreId(id)
                  setStoreCode(store.storeCode)
                }}
                disabled={importing}
                style={selectStyle}
              >
                {stores.map(s => (
                  <option key={s.storeId} value={s.storeId}>
                    {s.name} ({s.storeCode})
                  </option>
                ))}
              </select>

              <p
                style={{
                  margin: "20px 0",
                  padding: 12,
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--bg, transparent)",
                  fontSize: 13,
                  color: "var(--dim)",
                  lineHeight: 1.5,
                }}
              >
                This pulls active listings from eBay into your workspace. Existing records are updated, not
                duplicated.
              </p>

              <button
                type="button"
                onClick={() => void handleImport()}
                disabled={importing || !storeCode || isRunningStatus(importStatus?.syncStatus ?? null)}
                style={{
                  ...checklistPrimaryBtnStyle,
                  padding: "12px 24px",
                  fontSize: 15,
                  background:
                    importing || isRunningStatus(importStatus?.syncStatus ?? null)
                      ? "var(--dim)"
                      : checklistPrimaryBtnStyle.background,
                  cursor:
                    importing || !storeCode || isRunningStatus(importStatus?.syncStatus ?? null)
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                {importing ? "Syncing listings…" : "Import Listings"}
              </button>

              {(importing || statusPolling) && (
                <p style={{ margin: "16px 0 0", fontSize: 13, color: "var(--dim)" }}>
                  {importing
                    ? "Syncing active listings from eBay. This may take a minute for large catalogs."
                    : "Refreshing store counts and import status…"}
                </p>
              )}
            </div>
          )}

          {asinMatchMode && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                borderRadius: 6,
                border: "1px solid var(--accent, #3b82f6)",
                background: "rgba(59, 130, 246, 0.06)",
                fontSize: 14,
                lineHeight: 1.5,
              }}
            >
              Use this step after importing listings. Paste eBay Item ID and Amazon ASIN pairs to connect
              source products.
            </div>
          )}

          {selectedStore && selectedStore.listingCount === 0 && (
            <div style={{ ...warningBoxStyle, marginTop: 16 }}>
              Import listings first before linking ASINs.
              <div style={{ marginTop: 10 }}>
                <Link href={`/app/import?storeCode=${encodeURIComponent(selectedStore.storeCode)}`} style={ghostLinkStyle}>
                  Import Listings
                </Link>
              </div>
            </div>
          )}

          <LinkAmazonAsinsSection
            storeCode={storeCode}
            selectedStore={selectedStore}
            highlight={asinMatchMode}
            onMatchComplete={refreshSelectedStoreData}
          />
        </>
      )}
    </div>
  )
}

function ImportStoreSummary({
  store,
  importStatus,
}: {
  store: AppStoreSummary
  importStatus: AppImportStatusResponse | null
}) {
  return (
    <div style={{ ...cardStyle, marginTop: 16 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 12px", fontFamily: "'Syne', sans-serif" }}>Store summary</h2>
      <div style={{ fontSize: 13, color: "var(--dim)", lineHeight: 1.7 }}>
        <div>
          Listings: <strong style={{ color: "inherit" }}>{store.listingCount}</strong>
          {" · "}
          Active listings:{" "}
          <strong style={{ color: "inherit" }}>
            {importStatus != null ? importStatus.activeListingCount : "—"}
          </strong>
        </div>
        <div style={{ marginTop: 6 }}>
          Linked ASINs: {store.asinLinkedCount} · Needs ASIN: {store.needsAsinCount} · Completion:{" "}
          {store.asinCompletionPercent}%
        </div>
        <div style={{ marginTop: 6, fontSize: 12 }}>
          {store.storeCode} · {store.name}
          {store.connected ? "" : " · Not connected"}
        </div>
      </div>
    </div>
  )
}

function ImportStoreAsinSummary({ store }: { store: AppStoreSummary }) {
  return (
    <div
      style={{
        marginBottom: 16,
        padding: 12,
        borderRadius: 6,
        border: "1px solid var(--border)",
        background: "var(--bg, transparent)",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>ASIN Linking</div>
      <div style={{ fontSize: 13, color: "var(--dim)", lineHeight: 1.6 }}>
        Linked ASINs: {store.asinLinkedCount} · Needs ASIN: {store.needsAsinCount} · Completion:{" "}
        {store.asinCompletionPercent}%
      </div>
      <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 4 }}>
        {store.storeCode} · {store.name}
      </div>
    </div>
  )
}

function LinkAmazonAsinsSection({
  storeCode,
  selectedStore,
  highlight = false,
  onMatchComplete,
}: {
  storeCode: string
  selectedStore: AppStoreSummary | null
  highlight?: boolean
  onMatchComplete: () => Promise<void>
}) {
  const router = useRouter()
  const [text, setText] = useState("")
  const [clientErrors, setClientErrors] = useState<ImportValidateResult[] | null>(null)
  const [matching, setMatching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AppImportMatchResponse | null>(null)

  async function handleLinkAsins() {
    if (!storeCode || matching) return

    setError(null)
    setResult(null)

    const parsed = parseImportText(text)
    if (parsed.length === 0) {
      setError("Paste at least one row in the format: ebayItemId,ASIN")
      setClientErrors(null)
      return
    }

    if (parsed.length > 500) {
      setError("Too many rows — maximum 500 per request")
      return
    }

    const validated = validateImportRows(parsed)
    setClientErrors(validated)

    const validRows = validated
      .filter(r => r.status === "Valid Format" || r.status === "Duplicate ASIN")
      .map(r => ({ ebayItemId: r.ebayId, asin: r.asin }))

    if (validRows.length === 0) {
      setError("No valid rows to link. Fix the errors below and try again.")
      return
    }

    setMatching(true)
    const response = await importMatchAppListings({ storeCode, rows: validRows })
    setMatching(false)

    if (!response.ok) {
      if (response.status === 401) {
        router.replace("/app/login")
        return
      }
      if (response.status === 403 && response.approvalStatus === "pending_approval") {
        router.replace("/pending-approval")
        return
      }
      setError(response.error)
      return
    }

    setResult(response.data)
    await onMatchComplete()
  }

  function handleClearRows() {
    setText("")
    setClientErrors(null)
    setResult(null)
    setError(null)
  }

  function scrollToAsinInput() {
    document.getElementById("asin-match-text")?.focus()
    document.getElementById("asin-match-section")?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  function handleDownloadMatchErrors() {
    if (!result?.results?.length || !storeCode) return
    const csv = buildUserImportMatchErrorCsv(result.results)
    if (!csv) return
    downloadCsvFile(csv, formatUserImportMatchErrorFilename(storeCode))
  }

  const showDownloadErrors =
    result != null && hasUserImportMatchErrors(result.results)

  const needsAsinHref = `/app/listings?storeCode=${encodeURIComponent(storeCode)}&filter=needs-asin&page=1`
  const asinLinkedHref = `/app/listings?storeCode=${encodeURIComponent(storeCode)}&filter=asin-linked&page=1`

  return (
    <div
      id="asin-match-section"
      style={{
        ...cardStyle,
        marginTop: 16,
        ...(highlight ? { borderColor: "var(--accent, #3b82f6)" } : {}),
      }}
    >
      <h2 style={{ fontSize: 18, margin: "0 0 8px", fontFamily: "'Syne', sans-serif" }}>
        Link Amazon ASINs
      </h2>
      <p style={{ color: "var(--dim)", margin: "0 0 16px", fontSize: 14, lineHeight: 1.5 }}>
        {highlight
          ? "Use this step after importing listings. Paste eBay Item ID and Amazon ASIN pairs to connect source products."
          : "Paste eBay Item ID and Amazon ASIN pairs to connect your imported listings with their source products."}
      </p>

      {selectedStore && selectedStore.listingCount > 0 && (
        <ImportStoreAsinSummary store={selectedStore} />
      )}

      <label htmlFor="asin-match-text" style={{ display: "block", fontWeight: 600, marginBottom: 8, fontSize: 14 }}>
        eBay Item ID → ASIN pairs
      </label>
      <textarea
        id="asin-match-text"
        value={text}
        onChange={e => {
          setText(e.target.value)
          setClientErrors(null)
          setResult(null)
        }}
        disabled={matching || !storeCode}
        placeholder={"123456789012,B0XXXXXXXX\n123456789013,B0YYYYYYYY"}
        rows={6}
        style={textareaStyle}
      />

      <p style={{ margin: "8px 0 16px", fontSize: 12, color: "var(--dim)" }}>
        One pair per line. Separate with comma, tab, or space. Max 500 rows.
      </p>

      {error && (
        <div style={{ ...warningBoxStyle, borderColor: "#c44", color: "#e88", marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => void handleLinkAsins()}
          disabled={matching || !storeCode || !text.trim()}
          style={{
            ...checklistPrimaryBtnStyle,
            padding: "10px 20px",
            background: matching || !storeCode || !text.trim() ? "var(--dim)" : checklistPrimaryBtnStyle.background,
            cursor: matching || !storeCode || !text.trim() ? "not-allowed" : "pointer",
          }}
        >
          {matching ? "Linking ASINs…" : "Link ASINs"}
        </button>
        {text.trim() && (
          <button type="button" onClick={handleClearRows} disabled={matching} style={ghostBtnStyle}>
            Clear rows
          </button>
        )}
      </div>

      {clientErrors && clientErrors.some(r => r.status !== "Valid Format" && r.status !== "Duplicate ASIN") && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Input issues</div>
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Row</th>
                  <th style={thStyle}>eBay Item ID</th>
                  <th style={thStyle}>ASIN</th>
                  <th style={thStyle}>Status</th>
                </tr>
              </thead>
              <tbody>
                {clientErrors
                  .filter(r => r.status !== "Valid Format" && r.status !== "Duplicate ASIN")
                  .map(r => (
                    <tr key={r.row}>
                      <td style={tdStyle}>{r.row}</td>
                      <td style={tdStyle}>{r.ebayId || "—"}</td>
                      <td style={tdStyle}>{r.asin || "—"}</td>
                      <td style={tdStyle}>{r.status}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 20 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Link results</h3>
          <p style={{ margin: "0 0 12px", fontSize: 14, color: result.failed > 0 ? "#ca6" : "#6c9", lineHeight: 1.5 }}>
            {result.failed > 0
              ? "Some rows could not be linked. Review the results below."
              : "ASIN links were saved. Listing counts and filters have been refreshed."}
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <SummaryStat label="Total" value={result.total} />
            <SummaryStat label="Matched" value={result.matched} />
            <SummaryStat label="Skipped" value={result.skipped} />
            <SummaryStat label="Failed" value={result.failed} highlight={result.failed > 0} />
          </div>

          {result.results.length > 0 && (
            <div style={{ overflowX: "auto", marginBottom: 16 }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>eBay Item ID</th>
                    <th style={thStyle}>ASIN</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results.map(r => (
                    <tr key={`${r.ebayItemId}-${r.asin}-${r.status}`}>
                      <td style={tdStyle}>{r.ebayItemId || "—"}</td>
                      <td style={tdStyle}>{r.asin || "—"}</td>
                      <td style={{ ...tdStyle, color: matchStatusColor(r.status) }}>{r.status}</td>
                      <td style={tdStyle}>{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {showDownloadErrors && (
              <button type="button" onClick={handleDownloadMatchErrors} style={ghostBtnStyle}>
                Download Error CSV
              </button>
            )}
            <Link href={needsAsinHref} style={primaryLinkStyle}>
              View Updated Listings
            </Link>
            <Link href={asinLinkedHref} style={ghostLinkStyle}>
              View ASIN Linked Listings
            </Link>
            <button type="button" onClick={scrollToAsinInput} style={ghostBtnStyle}>
              Link More ASINs
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function matchStatusColor(status: string): string {
  if (status === "UPDATED" || status === "ALREADY_EXISTS" || status === "DUPLICATE_ASIN_WARNING") {
    return "#6c9"
  }
  if (status === "DUPLICATE_EBAY_ID") return "#eab308"
  return "#e88"
}

function ImportStatusCard({
  status,
  loading,
  polling,
  error,
  onRefresh,
}: {
  status: AppImportStatusResponse | null
  loading: boolean
  polling: boolean
  error: string | null
  onRefresh: () => void
}) {
  const statusLabel = formatSyncStatusLabel(status?.syncStatus ?? null)
  const isFailed = status?.syncStatus?.toLowerCase() === "error"
  const isRunning = isRunningStatus(status?.syncStatus ?? null)

  return (
    <div style={{ ...cardStyle, marginTop: 16 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <h2 style={{ fontSize: 18, margin: 0, fontFamily: "'Syne', sans-serif" }}>Import Status</h2>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || polling}
          style={{
            ...ghostBtnStyle,
            opacity: loading || polling ? 0.6 : 1,
            cursor: loading || polling ? "not-allowed" : "pointer",
          }}
        >
          {loading || polling ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div style={{ ...warningBoxStyle, borderColor: "#c44", color: "#e88", marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gap: 10, fontSize: 14 }}>
        <StatusRow
          label="Current status"
          value={
            <span style={{ color: statusColor(statusLabel, isFailed, isRunning) }}>
              {loading && !status ? "Loading…" : statusLabel}
              {polling && isRunning ? " (updating…)" : ""}
            </span>
          }
        />
        <StatusRow label="Last import/sync" value={fmtDateTime(status?.lastCatalogSyncAt)} />
        <StatusRow label="Listings" value={status ? String(status.listingCount) : "—"} />
        <StatusRow label="Active listings" value={status ? String(status.activeListingCount) : "—"} />
        <StatusRow label="Pending alerts" value={status ? String(status.pendingAlerts) : "—"} />
      </div>

      {status?.syncError && (
        <div style={{ ...warningBoxStyle, marginTop: 16 }}>
          <strong>Last error:</strong> {truncateError(status.syncError)}
        </div>
      )}
    </div>
  )
}

function statusColor(label: string, isFailed: boolean, isRunning: boolean): string {
  if (isFailed) return "#e88"
  if (isRunning) return "#eab308"
  if (label === "Completed") return "#6c9"
  return "inherit"
}

function truncateError(msg: string): string {
  const trimmed = msg.trim()
  if (trimmed.length <= 200) return trimmed
  return `${trimmed.slice(0, 197)}…`
}

function StatusRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, lineHeight: 1.5 }}>
      <span style={{ color: "var(--dim)" }}>{label}</span>
      <span style={{ textAlign: "right" }}>{value}</span>
    </div>
  )
}

function ImportResultSummary({
  result,
  onSyncAgain,
}: {
  result: AppListingsSyncResponse
  onSyncAgain: () => void
}) {
  const queued = result.accepted === true
  const hasErrors = (result.errors ?? 0) > 0
  const code = encodeURIComponent(result.storeCode)
  const allListingsHref = `/app/listings?storeId=${result.storeId}&storeCode=${code}&filter=all&page=1`
  const needsAsinHref = `/app/listings?storeId=${result.storeId}&storeCode=${code}&filter=needs-asin&page=1`
  const asinMatchHref = `/app/import?storeId=${result.storeId}&storeCode=${code}&mode=asin-match`

  return (
    <div style={{ ...cardStyle, marginBottom: 16 }}>
      <h2 style={{ fontSize: 20, margin: "0 0 8px", fontFamily: "'Syne', sans-serif" }}>
        {queued ? "Sync started" : "Import completed"}
      </h2>

      <p style={{ margin: "0 0 16px", fontSize: 14, color: hasErrors ? "#ca6" : "#6c9", lineHeight: 1.5 }}>
        {result.message
          ?? (hasErrors
            ? "Some listings could not be synced. Review the result summary or try again."
            : queued
              ? "Catalog sync is running in the background. Listings and Sold will refresh when it finishes."
              : "Listings were synced. Existing records were updated and new listings were imported.")}
      </p>

      {!queued && ((result.inserted ?? 0) > 0 || (result.updated ?? 0) > 0) && (
        <div style={{ marginBottom: 16, fontSize: 14, color: "var(--dim)", lineHeight: 1.6 }}>
          {(result.inserted ?? 0) > 0 && (
            <div>New listings imported: {result.inserted}</div>
          )}
          {(result.updated ?? 0) > 0 && (
            <div>Updated listings: {result.updated}</div>
          )}
        </div>
      )}

      {!queued && (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <SummaryStat label="Trading rows" value={result.tradingRows ?? 0} />
        <SummaryStat label="Inserted" value={result.inserted ?? 0} />
        <SummaryStat label="Updated" value={result.updated ?? 0} />
        <SummaryStat label="Skipped" value={result.skipped ?? 0} />
        <SummaryStat label="Errors" value={result.errors ?? 0} highlight={hasErrors} />
        <SummaryStat label="Reconciled" value={result.reconciled ?? 0} />
      </div>
      )}

      {!queued && result.syncHint && (
        <div style={{ marginBottom: 20, fontSize: 14, color: "var(--dim)", lineHeight: 1.5 }}>
          <strong style={{ color: "inherit" }}>Sync hint:</strong> {result.syncHint}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Link href={allListingsHref} style={primaryLinkStyle}>
          View Imported Listings
        </Link>
        <Link href={needsAsinHref} style={ghostLinkStyle}>
          Needs ASIN Listings
        </Link>
        <Link href={asinMatchHref} style={ghostLinkStyle}>
          Link Amazon ASINs
        </Link>
        <button type="button" onClick={onSyncAgain} style={ghostBtnStyle}>
          Sync Again
        </button>
      </div>
    </div>
  )
}

function SummaryStat({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number
  highlight?: boolean
}) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 8,
        border: `1px solid ${highlight ? "#c44" : "var(--border)"}`,
        background: highlight ? "rgba(200,60,60,0.06)" : "var(--bg, transparent)",
      }}
    >
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          fontFamily: "'Syne', sans-serif",
          color: highlight ? "#e88" : "inherit",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 4 }}>{label}</div>
    </div>
  )
}

const cardStyle: CSSProperties = {
  padding: 24,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
}

const errorBoxStyle: CSSProperties = {
  padding: 16,
  marginBottom: 16,
  borderRadius: 8,
  border: "1px solid #c44",
  background: "rgba(200,60,60,0.08)",
  color: "#e88",
}

const warningBoxStyle: CSSProperties = {
  padding: 12,
  marginBottom: 16,
  borderRadius: 6,
  border: "1px solid #ca6",
  background: "rgba(200,160,60,0.1)",
  color: "#ca6",
  fontSize: 14,
  lineHeight: 1.5,
}

const selectStyle: CSSProperties = {
  width: "100%",
  maxWidth: 360,
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg, var(--surface))",
  color: "inherit",
  fontSize: 14,
}

const ghostBtnStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 13,
}

const primaryLinkStyle: CSSProperties = {
  display: "inline-block",
  padding: "8px 16px",
  borderRadius: 6,
  border: "none",
  background: "var(--accent, #3b82f6)",
  color: "#fff",
  fontWeight: 600,
  textDecoration: "none",
  fontSize: 13,
}

const textareaStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg, var(--surface))",
  color: "inherit",
  fontSize: 13,
  fontFamily: "'JetBrains Mono', monospace",
  lineHeight: 1.5,
  resize: "vertical",
}

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 12,
}

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border)",
  color: "var(--dim)",
  fontWeight: 600,
}

const tdStyle: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
}

const ghostLinkStyle: CSSProperties = {
  display: "inline-block",
  padding: "8px 16px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  color: "inherit",
  textDecoration: "none",
  fontSize: 13,
}
