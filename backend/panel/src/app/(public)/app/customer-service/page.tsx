"use client"

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react"
import { useRouter } from "next/navigation"
import { fetchAuthMe, type UserPublic } from "@/lib/userAuthClient"
import {
  fetchAppCustomerService,
  fetchAppStores,
  saveAppCsAutomation,
  saveAppCsMaster,
  startAppEbayReconnect,
  type AppCustomerServiceResponse,
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

const selectStyle: CSSProperties = {
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 13,
}

const cardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 16,
  background: "var(--surface)",
  marginBottom: 16,
}

type AutomationType = "THANK_YOU" | "SHIPPED" | "DELAYED" | "DELIVERED"

function fmtDate(s: string | null | undefined): string {
  if (!s?.trim()) return "—"
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString()
}

export default function AppCustomerServicePage() {
  const router = useRouter()
  const { selectedStoreId, setSelectedStoreId, isStoreSelectionReady } = useAppStoreSelection()
  const selectedStoreIdRef = useRef(selectedStoreId)
  selectedStoreIdRef.current = selectedStoreId
  const [user, setUser] = useState<UserPublic | null>(null)
  const [stores, setStores] = useState<AppStoreSummary[]>([])
  const [storeCode, setStoreCode] = useState("")
  const [data, setData] = useState<AppCustomerServiceResponse | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reconnectBusy, setReconnectBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const loadPage = useCallback(async (code: string): Promise<boolean> => {
    if (!code) return false
    const result = await fetchAppCustomerService(code)
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
    setError(null)
    setData(result.data)
    const next: Record<string, string> = {}
    for (const a of result.data.automations) next[a.type] = a.template
    setDrafts(next)
    return true
  }, [router])

  const refreshAll = useCallback(async () => {
    if (!storeCode) return
    const storesResult = await fetchAppStores()
    if (storesResult.ok) setStores(storesResult.data.stores)
    await loadPage(storeCode)
  }, [storeCode, loadPage])

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
    await loadPage(validCode)
  }, [router, loadPage, setSelectedStoreId])

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
    void loadPage(code)
  }, [selectedStoreId, stores, isStoreSelectionReady, loading, storeCode, loadPage])

  function handleStoreChange(storeIdRaw: string) {
    const id = Number(storeIdRaw)
    const store = stores.find(s => s.storeId === id)
    if (!store) return
    setSelectedStoreId(id)
    setStoreCode(store.storeCode)
    const url = new URL(window.location.href)
    url.searchParams.set("storeCode", store.storeCode)
    window.history.replaceState(null, "", url.pathname + url.search)
    void loadPage(store.storeCode)
  }

  async function saveMaster(enabled: boolean) {
    if (!storeCode || saving) return
    setSaving(true)
    setMsg(null)
    const result = await saveAppCsMaster({ storeCode, enabled })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    await loadPage(storeCode)
    setMsg(
      enabled
        ? "Customer Service automations are ON for this store."
        : "Customer Service automations are OFF. No buyer messages will be sent."
    )
  }

  async function saveAutomation(type: AutomationType, patch: { template?: string }) {
    if (!storeCode || saving) return
    setSaving(true)
    setMsg(null)
    const result = await saveAppCsAutomation({ storeCode, type, ...patch })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    await loadPage(storeCode)
    setMsg(`${type} template saved for this store.`)
  }

  async function handleReconnect() {
    const store = stores.find(s => s.storeCode === storeCode)
    if (!store || reconnectBusy) return
    setReconnectBusy(true)
    const result = await startAppEbayReconnect(store.storeId)
    setReconnectBusy(false)
    if (!result.ok) {
      setError(result.error || "Reconnect could not start.")
      return
    }
    if (result.data.authUrl) {
      window.location.href = result.data.authUrl
    }
  }

  if (loading) {
    return <div style={{ padding: 48, textAlign: "center", color: "var(--dim)" }}>Loading…</div>
  }
  if (!user) return null

  const hasStores = stores.length > 0

  return (
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 12, marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: "'Syne', sans-serif", margin: 0, fontSize: 28 }}>Customer Service</h1>
          <p style={{ color: "var(--dim)", margin: "8px 0 0", fontSize: 14 }}>
            Store-scoped buyer automations. One master switch controls all four updates.
          </p>
        </div>
        {hasStores && (
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
        )}
      </div>

      {!hasStores && <NoStoreEmptyState />}

      {hasStores && (
        <>
          <AppHelpBox title="How automations work">
            Thank You queues on a new eBay order. Shipped, Delayed, and Delivered queue from exact-linked source events only.
            The master switch is OFF by default. Duplicate events do not send twice.
          </AppHelpBox>

          {error && (
            <p style={{ color: "#f87171", fontSize: 13, marginBottom: 12 }}>{error}</p>
          )}
          {msg && (
            <p style={{ color: "var(--accent)", fontSize: 13, marginBottom: 12 }}>{msg}</p>
          )}

          {data?.ebayMessage.reconnectRequired && (
            <div style={{ ...cardStyle, borderColor: "rgba(248,113,113,0.5)" }}>
              <strong>eBay message permission required</strong>
              <p style={{ margin: "8px 0 12px", fontSize: 13, color: "var(--dim)" }}>
                This store is missing the commerce.message scope for the Message API.
                Reconnect eBay to grant it. Fallback: Trading AddMemberMessageAAQToPartner
                (already available with the current seller token).
              </p>
              <button
                type="button"
                className="app-shell-logout-btn"
                onClick={() => void handleReconnect()}
                disabled={reconnectBusy}
              >
                {reconnectBusy ? "Yönlendiriliyor…" : "Reconnect eBay"}
              </button>
            </div>
          )}

          {data && (
            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 18 }}>Customer Service Automations</h2>
                  <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--dim)" }}>
                    When enabled, ListJetGo automatically sends order confirmation, shipped, delayed, and delivered updates for this store.
                  </p>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, whiteSpace: "nowrap" }}>
                  <input
                    type="checkbox"
                    checked={Boolean(data.masterEnabled)}
                    disabled={saving}
                    onChange={e => void saveMaster(e.target.checked)}
                    aria-label="Customer Service Automations"
                  />
                  {data.masterEnabled ? "ON" : "OFF"}
                </label>
              </div>
            </div>
          )}

          {(data?.automations ?? []).map(automation => (
            <div key={automation.type} style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 18 }}>{automation.label}</h2>
                  <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--dim)" }}>
                    {automation.type === "THANK_YOU" && "Order confirmation after a new eBay sale."}
                    {automation.type === "SHIPPED" && "Sent when the linked source order ships."}
                    {automation.type === "DELAYED" && "Sent when the linked source order is delayed."}
                    {automation.type === "DELIVERED" && "Sent when the linked source order is delivered."}
                  </p>
                </div>
                <span style={{ fontSize: 12, color: "var(--dim)", marginTop: 4 }}>
                  {data?.masterEnabled ? "Active" : "Paused"}
                </span>
              </div>
              <p style={{ fontSize: 12, color: "var(--dim)", marginTop: 10 }}>
                Placeholders: {(automation.placeholders ?? []).join(" ")}
              </p>
              {automation.type === "DELIVERED" && (
                <p style={{ fontSize: 12, color: "var(--dim)", marginTop: 4 }}>
                  Delivery photo is included automatically when available.
                </p>
              )}
              <textarea
                value={drafts[automation.type] ?? ""}
                onChange={e => setDrafts(prev => ({ ...prev, [automation.type]: e.target.value }))}
                rows={5}
                style={{
                  width: "100%",
                  marginTop: 8,
                  background: "var(--bg)",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: 10,
                  fontSize: 13,
                  fontFamily: "inherit",
                }}
              />
              <button
                type="button"
                onClick={() => void saveAutomation(automation.type as AutomationType, { template: drafts[automation.type] ?? "" })}
                disabled={saving}
                style={{ marginTop: 10, ...selectStyle, cursor: "pointer" }}
              >
                {saving ? "Saving…" : "Save template"}
              </button>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginTop: 14 }}>
                <div>
                  <div style={{ fontSize: 12, color: "var(--dim)" }}>Sent today</div>
                  <div style={{ fontSize: 20, marginTop: 4 }}>{automation.stats?.sentToday ?? 0}</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: "var(--dim)" }}>Failed</div>
                  <div style={{ fontSize: 20, marginTop: 4 }}>{automation.stats?.failed ?? 0}</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: "var(--dim)" }}>Last sent</div>
                  <div style={{ fontSize: 13, marginTop: 8 }}>{fmtDate(automation.stats?.lastSentAt)}</div>
                </div>
              </div>
            </div>
          ))}

          <div style={cardStyle}>
            <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Recent activity</h2>
            {!data?.recent.length ? (
              <p style={{ color: "var(--dim)", fontSize: 13, margin: 0 }}>No sends for this store yet.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--dim)" }}>
                    <th style={{ padding: "6px 8px" }}>Automation</th>
                    <th style={{ padding: "6px 8px" }}>Order</th>
                    <th style={{ padding: "6px 8px" }}>Status</th>
                    <th style={{ padding: "6px 8px" }}>Source</th>
                    <th style={{ padding: "6px 8px" }}>Time</th>
                    <th style={{ padding: "6px 8px" }}>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map(row => (
                    <tr key={row.id}>
                      <td style={{ padding: "6px 8px" }}>{row.automationType}</td>
                      <td style={{ padding: "6px 8px" }}>{row.ebayOrderId}</td>
                      <td style={{ padding: "6px 8px" }}>{row.status}</td>
                      <td style={{ padding: "6px 8px" }}>{row.sourceEventType || "—"}</td>
                      <td style={{ padding: "6px 8px" }}>{fmtDate(row.sentAt || row.createdAt)}</td>
                      <td style={{ padding: "6px 8px", color: "#f87171" }}>{row.lastError || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
