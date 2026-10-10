"use client"

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { fetchAuthMe, type UserPublic } from "@/lib/userAuthClient"
import {
  fetchAppStockGuardStatus,
  fetchAppStores,
  type AppStockGuardStatus,
  type AppStoreSummary,
} from "@/lib/userAppClient"
import { NoStoreEmptyState } from "@/components/app/NoStoreEmptyState"
import { AppHelpBox } from "@/components/app/AppHelpBox"
import { useFocusRefetch } from "@/components/app/useFocusRefetch"
import {
  adoptStoreSelection,
  parseUrlStoreId,
  storeCodeForId,
  useAppStoreSelection,
} from "@/lib/appStoreSelection"

// Retained only for the legacy dead-code modal below; no approval controls are
// rendered by this page anymore.
type FormState = {
  mode: "manual" | "auto"
  autoProfitProtectionEnabled: boolean
}

function fmtDate(s: string | null | undefined): string {
  if (!s?.trim()) return "—"
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString()
}

function fmtRunStatus(status: string | null | undefined): string {
  if (!status?.trim()) return "No scan data yet"
  return status.replace(/_/g, " ")
}

function fmtCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "Not available yet"
  return String(n)
}

function fmtScanDate(s: string | null | undefined): string {
  if (!s?.trim()) return "No scan data yet"
  return fmtDate(s)
}

export default function AppStockGuardPage() {
  const router = useRouter()
  const { selectedStoreId, setSelectedStoreId, isStoreSelectionReady } = useAppStoreSelection()
  const selectedStoreIdRef = useRef(selectedStoreId)
  selectedStoreIdRef.current = selectedStoreId
  const [user, setUser] = useState<UserPublic | null>(null)
  const [stores, setStores] = useState<AppStoreSummary[]>([])
  const [storeCode, setStoreCode] = useState("")
  const [guardStatus, setGuardStatus] = useState<AppStockGuardStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchStatusData = useCallback(
    async (code: string): Promise<boolean> => {
      if (!code) return false
      const result = await fetchAppStockGuardStatus(code)
      if (!result.ok) {
        if (result.status === 401) {
          router.replace("/app/login")
          return false
        }
        if (result.status === 403 && result.approvalStatus === "pending_approval") {
          router.replace("/pending-approval")
          return false
        }
        return false
      }
      setGuardStatus(result.data.status)
      return true
    },
    [router]
  )

  const refreshAll = useCallback(async () => {
    if (!storeCode) return
    setRefreshing(true)
    const storesResult = await fetchAppStores()
    if (storesResult.ok) {
      setStores(storesResult.data.stores)
    }
    await fetchStatusData(storeCode)
    setRefreshing(false)
  }, [storeCode, fetchStatusData])

  useFocusRefetch(refreshAll, { enabled: !loading && Boolean(storeCode) })

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

    setStoreCode(validCode)
    setLoading(false)
    await fetchStatusData(validCode)
  }, [router, fetchStatusData, setSelectedStoreId])

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
    const url = new URL(window.location.href)
    url.searchParams.set("storeCode", code)
    window.history.replaceState(null, "", url.pathname + url.search)
    void fetchStatusData(code)
  }, [selectedStoreId, stores, isStoreSelectionReady, loading, storeCode, fetchStatusData])

  function handleStoreChange(storeIdRaw: string) {
    const id = Number(storeIdRaw)
    const store = stores.find(s => s.storeId === id)
    if (!store) return
    setSelectedStoreId(id)
    setStoreCode(store.storeCode)
    const url = new URL(window.location.href)
    url.searchParams.set("storeCode", store.storeCode)
    window.history.replaceState(null, "", url.pathname + url.search)
    void fetchStatusData(store.storeCode)
  }

  if (loading) {
    return <div style={{ padding: 48, textAlign: "center", color: "var(--dim)" }}>Loading…</div>
  }

  if (!user) return null

  const hasStores = stores.length > 0
  const stockAlertsHref = `/app/stock-alerts?storeCode=${encodeURIComponent(storeCode)}`
  const pendingAlertsHref = `${stockAlertsHref}&status=pending&page=1`
  const failedAlertsHref = `${stockAlertsHref}&status=failed&page=1`
  const listingsHref = `/app/listings?storeCode=${encodeURIComponent(storeCode)}&filter=all&page=1`
  const statusEnabled = guardStatus?.enabled ?? true
  const statusMode = "auto"

  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <Link href="/app/dashboard" style={{ color: "var(--dim)", fontSize: 14, textDecoration: "none" }}>
          ← Dashboard
        </Link>
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <h1 style={{ fontFamily: "'Syne', sans-serif", margin: 0, fontSize: 28 }}>Stock Guard</h1>
          {refreshing && <span style={{ fontSize: 12, color: "var(--dim)" }}>Refreshing…</span>}
        </div>
        <p style={{ color: "var(--dim)", margin: "8px 0 0", fontSize: 14 }}>
          Configure how Stock Guard monitors source products and handles risky listings.
        </p>
      </div>

      <AppHelpBox text="Protection is automatic for eligible listings. To exclude an individual listing, use Listings → Disable Guard." />

      {error && (
        <div style={errorBoxStyle}>
          <p style={{ margin: "0 0 12px" }}>{error}</p>
          <button type="button" onClick={() => (hasStores ? void refreshAll() : void init())} style={btnStyle}>
            Retry
          </button>
        </div>
      )}

      {!hasStores ? (
        <NoStoreEmptyState description="Connect your eBay store to view Stock Guard monitoring." />
      ) : (
        <>
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>
              Store
              <select
                value={selectedStoreId != null ? String(selectedStoreId) : ""}
                onChange={e => handleStoreChange(e.target.value)}
                style={selectStyle}
              >
                {stores.map(s => (
                  <option key={s.storeId} value={s.storeId}>
                    {s.storeCode} — {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <section style={cardStyle}>
                <h2 style={cardTitleStyle}>Guard Status</h2>
                <div style={overviewGridStyle}>
                  <div>
                    <div style={fieldLabelStyle}>Enabled</div>
                    <span style={statusEnabled ? enabledBadgeStyle : disabledBadgeStyle}>
                      {statusEnabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Mode</div>
                    <div style={fieldValueStyle}>
                      {statusMode === "auto" ? "Automatic" : "Manual"}
                    </div>
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Last run status</div>
                    <div style={fieldValueStyle}>{fmtRunStatus(guardStatus?.lastRunStatus)}</div>
                  </div>
                </div>
              </section>

              <section style={cardStyle}>
                <h2 style={cardTitleStyle}>Scan Activity</h2>
                <div style={overviewGridStyle}>
                  <div>
                    <div style={fieldLabelStyle}>Last scan</div>
                    <div style={fieldValueStyle}>{fmtScanDate(guardStatus?.lastScanAt)}</div>
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Last completed scan</div>
                    <div style={fieldValueStyle}>{fmtScanDate(guardStatus?.lastCompletedScanAt)}</div>
                  </div>
                  <div style={{ gridColumn: "1 / -1" }}>
                    <div style={fieldLabelStyle}>Last error</div>
                    <div
                      style={{
                        ...fieldValueStyle,
                        color: guardStatus?.lastError ? "#e88" : "var(--dim)",
                        fontSize: 13,
                      }}
                    >
                      {guardStatus?.lastError ?? "None"}
                    </div>
                  </div>
                </div>
              </section>

              <section style={cardStyle}>
                <h2 style={cardTitleStyle}>Alert Summary</h2>
                <div style={overviewGridStyle}>
                  <div>
                    <div style={fieldLabelStyle}>Pending</div>
                    <div style={statValueStyle}>{fmtCount(guardStatus?.pendingAlertsCount)}</div>
                    {(guardStatus?.pendingAlertsCount ?? 0) > 0 && (
                      <Link href={pendingAlertsHref} style={statLinkStyle}>
                        View pending
                      </Link>
                    )}
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Processing</div>
                    <div style={statValueStyle}>{fmtCount(guardStatus?.processingAlertsCount)}</div>
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Failed</div>
                    <div style={statValueStyle}>{fmtCount(guardStatus?.failedAlertsCount)}</div>
                    {(guardStatus?.failedAlertsCount ?? 0) > 0 && (
                      <Link href={failedAlertsHref} style={statLinkStyle}>
                        View failed
                      </Link>
                    )}
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Actioned</div>
                    <div style={statValueStyle}>{fmtCount(guardStatus?.actionedAlertsCount)}</div>
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Ignored</div>
                    <div style={statValueStyle}>{fmtCount(guardStatus?.ignoredAlertsCount)}</div>
                  </div>
                </div>
              </section>

              <section style={cardStyle}>
                <h2 style={cardTitleStyle}>Listing Protection</h2>
                <div style={overviewGridStyle}>
                  <div>
                    <div style={fieldLabelStyle}>Protected listings</div>
                    <div style={statValueStyle}>{fmtCount(guardStatus?.protectedListingsCount)}</div>
                    <span style={hintStyle}>Live listings monitored by Stock Guard</span>
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Zero quantity listings</div>
                    <div style={statValueStyle}>{fmtCount(guardStatus?.zeroQuantityListingsCount)}</div>
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <Link href={listingsHref} style={statLinkStyle}>
                    View listings
                  </Link>
                </div>
              </section>

              <section style={cardStyle}>
                <h2 style={cardTitleStyle}>Pipeline health</h2>
                <div style={overviewGridStyle}>
                  <div>
                    <div style={fieldLabelStyle}>Keepa Radar</div>
                    <div style={fieldValueStyle}>{guardStatus?.keepaRadar ?? "Off"}</div>
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Last Keepa scan</div>
                    <div style={fieldValueStyle}>{fmtScanDate(guardStatus?.lastKeepaScanAt)}</div>
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Active ASINs</div>
                    <div style={statValueStyle}>{fmtCount(guardStatus?.activeAsins)}</div>
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Pending verification</div>
                    <div style={statValueStyle}>{fmtCount(guardStatus?.pendingVerificationTasks)}</div>
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Waiting for worker</div>
                    <div style={statValueStyle}>{fmtCount(guardStatus?.waitingForWorkerTasks)}</div>
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Online extension workers</div>
                    <div style={statValueStyle}>{fmtCount(guardStatus?.onlineExtensionWorkers)}</div>
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Last verified source</div>
                    <div style={fieldValueStyle}>{fmtScanDate(guardStatus?.lastVerifiedSourceAt)}</div>
                  </div>
                  <div>
                    <div style={fieldLabelStyle}>Last protection action</div>
                    <div style={fieldValueStyle}>{fmtScanDate(guardStatus?.lastProtectionActionAt)}</div>
                  </div>
                </div>
              </section>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                <Link href={stockAlertsHref} style={linkBtnStyle}>
                  View Stock Alerts
                </Link>
              </div>
          </div>
        </>
      )}

    </div>
  )
}

function HighRiskConfirmModal({
  form,
  onClose,
  onConfirm,
}: {
  form: FormState
  onClose: () => void
  onConfirm: () => Promise<boolean>
}) {
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [confirmationText, setConfirmationText] = useState("")
  const [loading, setLoading] = useState(false)

  const autoMode = form.mode === "auto"
  const autoProfit = form.autoProfitProtectionEnabled
  const canSubmit = confirmChecked && confirmationText.trim().toUpperCase() === "AUTO" && !loading

  async function handleConfirm() {
    if (!canSubmit) return
    setLoading(true)
    await onConfirm()
    setLoading(false)
  }

  const title =
    autoMode && autoProfit
      ? "Enable automatic zeroing and Auto Profit Protection?"
      : autoMode
        ? "Enable automatic zeroing?"
        : "Enable Auto Profit Protection?"

  const description =
    autoMode && autoProfit
      ? "This may automatically set eBay quantity to 0 for risky listings and increase eBay prices when trusted source prices rise."
      : autoMode
        ? "This may set your eBay listing quantity to 0 automatically when Stock Guard detects source risk."
        : "This may automatically increase your eBay listing prices when trusted source prices rise."

  return (
    <div className="app-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="app-modal"
        role="dialog"
        aria-labelledby="stock-guard-confirm-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="app-modal-header">
          <div>
            <h2 id="stock-guard-confirm-title" className="app-modal-title">
              {title}
            </h2>
            <p className="app-modal-subtitle">{description}</p>
          </div>
          <button type="button" className="app-modal-close-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="app-modal-apply-section">
          <label className="app-modal-apply-label" htmlFor="stock-guard-auto-text">
            Type AUTO to confirm.
          </label>
          <input
            id="stock-guard-auto-text"
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
            I understand this can automatically update my eBay listings.
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
            onClick={() => void handleConfirm()}
          >
            {loading ? "Saving…" : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  )
}

const statValueStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  lineHeight: 1.2,
}

const statLinkStyle: CSSProperties = {
  display: "inline-block",
  marginTop: 6,
  fontSize: 12,
  color: "inherit",
  textDecoration: "none",
  borderBottom: "1px solid var(--border)",
}

const cardStyle: CSSProperties = {
  padding: 16,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
}

const cardTitleStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 16,
  fontWeight: 600,
}

const overviewGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 12,
}

const fieldLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--dim)",
  textTransform: "uppercase",
  marginBottom: 4,
}

const fieldValueStyle: CSSProperties = {
  fontSize: 14,
}

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 13,
}

const selectStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "inherit",
  fontSize: 13,
  maxWidth: 360,
}

const checkboxRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  fontSize: 14,
  lineHeight: 1.45,
  cursor: "pointer",
}

const radioRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  marginTop: 8,
  fontSize: 14,
  lineHeight: 1.45,
  cursor: "pointer",
}

const hintStyle: CSSProperties = {
  display: "block",
  marginTop: 4,
  fontSize: 12,
  color: "var(--dim)",
}

const enabledBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  background: "rgba(60,180,120,0.15)",
  color: "#6c9",
}

const disabledBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  background: "rgba(148, 163, 184, 0.15)",
  color: "var(--dim)",
}

const btnStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 13,
}

const primaryBtnStyle: CSSProperties = {
  background: "var(--accent, #3b82f6)",
  color: "#fff",
  border: "none",
  fontWeight: 600,
}

const linkBtnStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  textDecoration: "none",
  fontSize: 13,
}

const errorBoxStyle: CSSProperties = {
  padding: 16,
  marginBottom: 16,
  borderRadius: 8,
  border: "1px solid #c44",
  background: "rgba(200,60,60,0.08)",
  color: "#e88",
}

const successBoxStyle: CSSProperties = {
  padding: 16,
  borderRadius: 8,
  border: "1px solid rgba(60,180,120,0.35)",
  background: "rgba(60,180,120,0.08)",
  color: "#6c9",
}
