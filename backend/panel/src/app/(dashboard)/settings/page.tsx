"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useStore } from "@/lib/storeContext"
import { useToast } from "@/lib/toastContext"
import {
  emptyPricingRangeRow,
  rangesToFormRows,
  validatePricingRangeRows,
  type PricingRangeRow,
  type TieredProfitRange,
} from "@/lib/pricingRanges"
import { InfoTooltip } from "@/components/ui/InfoTooltip"
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "https://api.listjetgo.com"

const DEFAULT_POLICY_OPTIONS = {
  fulfillmentPolicies: [] as { id: string; name: string }[],
  paymentPolicies:     [] as { id: string; name: string }[],
  returnPolicies:      [] as { id: string; name: string }[],
}

/** option value = ISO2 (US, GB, …); görünen metin = label */
const COUNTRY_OPTIONS = [
  { value: "US", label: "United States" },
  { value: "GB", label: "United Kingdom" },
  { value: "DE", label: "Germany" },
  { value: "FR", label: "France" },
  { value: "AU", label: "Australia" },
  { value: "CA", label: "Canada" },
  { value: "TR", label: "Turkey" },
  { value: "IT", label: "Italy" },
  { value: "ES", label: "Spain" },
  { value: "NL", label: "Netherlands" },
  { value: "IE", label: "Ireland" },
  { value: "AT", label: "Austria" },
  { value: "BE", label: "Belgium" },
  { value: "PL", label: "Poland" },
  { value: "SE", label: "Sweden" },
  { value: "CH", label: "Switzerland" },
  { value: "JP", label: "Japan" },
  { value: "MX", label: "Mexico" },
  { value: "BR", label: "Brazil" },
  { value: "IN", label: "India" },
  { value: "SG", label: "Singapore" },
  { value: "HK", label: "Hong Kong" },
] as const

const ISO2_SET = new Set<string>(COUNTRY_OPTIONS.map((c) => c.value))

/** API’ye yalnızca ISO2 gider; eski “United States (US)” vb. metinleri düzeltir */
function toIso2Country(raw: string | null | undefined, fallback: string): string {
  const t = (raw ?? "").trim().toUpperCase()
  if (ISO2_SET.has(t)) return t
  const inParens = t.match(/\(([A-Z]{2})\)\s*$/)
  if (inParens && ISO2_SET.has(inParens[1])) return inParens[1]
  const byLabel = COUNTRY_OPTIONS.find(
    (c) => c.label.toUpperCase() === t || t.startsWith(c.label.toUpperCase())
  )
  if (byLabel) return byLabel.value
  return fallback
}

type AdminStoreRow = {
  id: number
  name: string
  storeCode: string
  status: string
  createdAt: string
}

type AddressDto = {
  firstName: string
  lastName: string
  company: string | null
  address1: string
  address2: string | null
  city: string
  state: string
  zip: string
  country: string
}

type SettingsResponse = {
  storeCode:             string
  storeName:             string
  markupPercent:         number
  pricingMode:           "PERCENTAGE_NET_PROFIT" | "TIERED_MIN_NET_PROFIT"
  percentageNetProfitPercent: number
  tieredProfitOverrides: TieredProfitRange[]
  countryOrRegion:       string | null
  cityState:             string | null
  address:               AddressDto | null
  merchantLocationKey:   string | null
  registrationCountry:   string | null
  fulfillmentPolicyId:   string | null
  paymentPolicyId:       string | null
  returnPolicyId:        string | null
  warehouseShippingBannerEnabled?: boolean
}

type PolicyOption = { id: string; name: string }

type PoliciesResponse = {
  fulfillmentPolicies: PolicyOption[]
  paymentPolicies:     PolicyOption[]
  returnPolicies:      PolicyOption[]
}

function normalizePoliciesResponse(raw: unknown): PoliciesResponse {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return { ...DEFAULT_POLICY_OPTIONS }
  }
  const o = raw as Record<string, unknown>
  const arr = (k: string): PolicyOption[] => {
    const v = o[k]
    if (!Array.isArray(v)) return []
    return v
      .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
      .map(x => ({
        id:   String(x.id ?? x.fulfillmentPolicyId ?? x.paymentPolicyId ?? x.returnPolicyId ?? ""),
        name: String(x.name ?? ""),
      }))
      .filter(p => p.id.length > 0)
  }
  return {
    fulfillmentPolicies: arr("fulfillmentPolicies"),
    paymentPolicies:     arr("paymentPolicies"),
    returnPolicies:      arr("returnPolicies"),
  }
}

const estimatedListingPrice = (cost: number, profit: number) =>
  Math.ceil(((cost + profit + 0.50) / (1 - 1.09 * 0.171)) * 100 - 1e-9) / 100

function emptyAddress(): {
  firstName: string
  lastName: string
  company: string
  address1: string
  address2: string
  city: string
  state: string
  zip: string
  country: string
  registrationCountry: string
} {
  return {
    firstName: "",
    lastName: "",
    company: "",
    address1: "",
    address2: "",
    city: "",
    state: "",
    zip: "",
    country: "US",
    registrationCountry: "US",
  }
}

type EbayAccountStatus = {
  storeCode:           string
  storeName:           string
  connected:           boolean
  ebayUserId:          string | null
  expiresAt:           string | null
  expiresIn:           number | null
  expired:             boolean
  scope:               string | null
  hasAnalyticsScope?: boolean
}

function EbayConnectSection({
  storeCode,
  storeDisplayName,
  onDisconnected,
}: {
  storeCode: string
  /** Panel mağaza listesinden — disconnect onayı vb. için (kod göstermemek) */
  storeDisplayName?: string
  onDisconnected?: () => void | Promise<void>
}) {
  const [status, setStatus] = useState<EbayAccountStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [updatingPerms, setUpdatingPerms] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadStatus() {
    try {
      const res = await fetch(
        `${API_BASE}/admin/ebay/account-status?storeCode=${storeCode}`
      )
      const data = (await res.json()) as EbayAccountStatus
      setStatus(data)
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadStatus()
  }, [storeCode])

  async function handleConnect() {
    setConnecting(true)
    setError(null)
    try {
      const res = await fetch(
        `${API_BASE}/admin/ebay/connect-url?storeCode=${storeCode}`
      )
      const data = (await res.json()) as { authUrl: string }
      // Auth URL our callback route directly navigates.
      window.location.href = data.authUrl
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connect failed")
    } finally {
      setConnecting(false)
    }
  }

  async function handleUpdatePermissions() {
    setUpdatingPerms(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/admin/ebay/oauth/reconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeCode, force: true }),
      })
      const data = (await res.json()) as { ok?: boolean; authUrl?: string; error?: string }
      if (!res.ok || !data.ok || !data.authUrl) {
        throw new Error(data.error ?? `Permission update failed: ${res.status}`)
      }
      window.location.href = data.authUrl
    } catch (e) {
      setError(e instanceof Error ? e.message : "Permission update failed")
      setUpdatingPerms(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/admin/ebay/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeCode }),
      })
      if (!res.ok) throw new Error(`Refresh failed: ${res.status}`)
      await loadStatus()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed")
    } finally {
      setRefreshing(false)
    }
  }

  async function handleDisconnect() {
    const displayName =
      status?.storeName?.trim() || storeDisplayName?.trim() || "Store"
    const ok = window.confirm(
      `Remove store ${displayName} and disconnect eBay? This deletes the store and its eBay link.`
    )
    if (!ok) return

    setError(null)
    try {
      const res = await fetch(`${API_BASE}/admin/ebay/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeCode }),
      })
      if (!res.ok) throw new Error(await res.text().catch(() => "Disconnect failed"))
      await onDisconnected?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed")
    }
  }

  if (loading) {
    return (
      <div
        style={{
          fontSize: "11px",
          color: "var(--dim)",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        Checking eBay status...
      </div>
    )
  }

  const expMin = status?.expiresIn ? Math.round(status.expiresIn / 60) : null

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        paddingTop: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span
          style={{
            padding: "2px 8px",
            borderRadius: "20px",
            fontSize: "10px",
            fontWeight: 700,
            fontFamily: "'JetBrains Mono', monospace",
            textTransform: "uppercase",
            background:
              status?.connected && !status.expired
                ? "rgba(0,255,136,0.12)"
                : "rgba(136,136,136,0.12)",
            color:
              status?.connected && !status.expired
                ? "var(--accent)"
                : "var(--dim)",
          }}
        >
          {status?.connected && !status.expired
            ? "Connected"
            : status?.expired
              ? "Expired"
              : "Not Connected"}
        </span>
        {status?.ebayUserId && (
          <span
            style={{
              fontSize: "11px",
              color: "var(--sub)",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {status.ebayUserId}
          </span>
        )}
      </div>

      {status?.connected && expMin !== null && (
        <p
          style={{
            fontSize: "11px",
            color: expMin < 30 ? "var(--warn)" : "var(--dim)",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {expMin > 0 ? `Token expires in ${expMin} min` : "Token expired"}
        </p>
      )}

      {status?.connected && (
        <p
          style={{
            fontSize: "11px",
            color: status.hasAnalyticsScope ? "var(--accent)" : "var(--warn)",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {status.hasAnalyticsScope
            ? "Analytics izni aktif"
            : "Analytics izni eksik — 30D Clicks çalışmaz"}
        </p>
      )}

      {error && (
        <p
          style={{
            fontSize: "11px",
            color: "var(--danger)",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {error}
        </p>
      )}

      <div style={{ display: "flex", gap: "8px" }}>
        {!status?.connected || status.expired ? (
          <button
            onClick={handleConnect}
            disabled={connecting}
            style={{
              padding: "6px 14px",
              borderRadius: "3px",
              border: "none",
              cursor: connecting ? "not-allowed" : "pointer",
              background: connecting ? "var(--muted)" : "var(--accent)",
              color: "#000",
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 700,
              fontSize: "11px",
              letterSpacing: "0.5px",
              textTransform: "uppercase",
              opacity: connecting ? 0.6 : 1,
            }}
          >
            {connecting ? "Connecting..." : "Connect eBay"}
          </button>
        ) : (
          <>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              style={{
                padding: "6px 14px",
                borderRadius: "3px",
                border: "1px solid var(--border)",
                cursor: refreshing ? "not-allowed" : "pointer",
                background: "transparent",
                color: "var(--sub)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
                opacity: refreshing ? 0.6 : 1,
              }}
            >
              {refreshing ? "Refreshing..." : "Refresh Token"}
            </button>
            <button
              onClick={() => { void handleUpdatePermissions() }}
              disabled={updatingPerms}
              title="Update Permissions — eBay consent screen"
              style={{
                padding: "6px 14px",
                borderRadius: "3px",
                border: status?.hasAnalyticsScope
                  ? "1px solid var(--border)"
                  : "1px solid rgba(255,200,0,0.45)",
                cursor: updatingPerms ? "not-allowed" : "pointer",
                background: status?.hasAnalyticsScope
                  ? "transparent"
                  : "rgba(255,200,0,0.08)",
                color: status?.hasAnalyticsScope ? "var(--dim)" : "var(--warn)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
                opacity: updatingPerms ? 0.6 : 1,
              }}
            >
              {updatingPerms ? "Yönlendiriliyor..." : "İzinleri Yenile"}
            </button>
            <button
              type="button"
              onClick={handleDisconnect}
              style={{
                padding: "6px 14px",
                borderRadius: "3px",
                border: "1px solid rgba(255,68,85,0.3)",
                cursor: "pointer",
                background: "transparent",
                color: "var(--danger)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
              }}
            >
              Disconnect
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const router = useRouter()
  const { selectedStore, setSelectedStore } = useStore()
  const { showToast } = useToast()
  const [stores, setStores] = useState<AdminStoreRow[]>([])
  const [storesLoading, setStoresLoading] = useState(true)
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [policyOptions, setPolicyOptions] = useState<PoliciesResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const [createStoreOpen, setCreateStoreOpen] = useState(false)
  const [createStoreName, setCreateStoreName] = useState("")
  const [createStoreCode, setCreateStoreCode] = useState("")
  const [creatingStore, setCreatingStore] = useState(false)
  const [createStoreError, setCreateStoreError] = useState<string | null>(null)
  const [addingStoreOAuth, setAddingStoreOAuth] = useState(false)

  const [loc, setLoc] = useState(emptyAddress)

  const [returnId, setReturnId] = useState("")
  const [fulfillmentId, setFulfillmentId] = useState("")
  const [paymentId, setPaymentId] = useState("")

  const [savingLocation, setSavingLocation] = useState(false)
  const [savedLocation, setSavedLocation] = useState(false)
  const [savingPolicies, setSavingPolicies] = useState(false)
  const [savedPolicies, setSavedPolicies] = useState(false)
  const [pricingMode, setPricingMode] = useState<SettingsResponse["pricingMode"]>("PERCENTAGE_NET_PROFIT")
  const [percentageNetProfitPercent, setPercentageNetProfitPercent] = useState("35")
  const [tieredProfitRows, setTieredProfitRows] = useState<PricingRangeRow[]>([])
  const [savingPricing, setSavingPricing] = useState(false)
  const [savedPricing, setSavedPricing] = useState(false)
  const [warehouseBannerEnabled, setWarehouseBannerEnabled] = useState(false)
  const [savingBanner, setSavingBanner] = useState(false)
  const [savedBanner, setSavedBanner] = useState(false)

  const effectivePolicyOptions = policyOptions ?? DEFAULT_POLICY_OPTIONS

  const loadStores = useCallback(async () => {
    setStoresLoading(true)
    try {
      const res = await fetch(`${API_BASE}/admin/stores`, { cache: "no-store" })
      if (!res.ok) throw new Error(await res.text())
      const data = (await res.json()) as { rows?: AdminStoreRow[] }
      const rows = Array.isArray(data.rows) ? data.rows : []
      setStores(rows)
    } catch {
      setStores([])
    } finally {
      setStoresLoading(false)
    }
  }, [])

  useEffect(() => { void loadStores() }, [loadStores])

  useEffect(() => {
    if (storesLoading) return
    if (stores.length === 0) {
      setSelectedStore("S1")
      return
    }
    if (!stores.some((s) => s.storeCode === selectedStore)) {
      setSelectedStore(stores[0]!.storeCode)
    }
  }, [stores, storesLoading, selectedStore, setSelectedStore])

  useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    if (params.get("ebay_oauth") !== "1") return

    if (window.opener && !window.opener.closed) {
      try {
        window.opener.location.reload()
      } catch {
        /* ignore */
      }
      window.close()
      return
    }

    params.delete("ebay_oauth")
    const qs = params.toString()
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`
    window.history.replaceState({}, "", next)
    void loadStores()
    showToast("eBay store connected.", "success")
  }, [loadStores, showToast])

  async function handleAddStore() {
    setAddingStoreOAuth(true)
    try {
      const res = await fetch(`${API_BASE}/admin/ebay/connect`, {
        method: "POST",
        credentials: "include",
      })
      if (!res.ok) {
        showToast((await res.text().catch(() => "")) || `HTTP ${res.status}`, "error")
        return
      }
      const data = (await res.json()) as { authUrl?: string }
      if (!data.authUrl) {
        showToast("No auth URL returned", "error")
        return
      }
      window.open(data.authUrl, "_blank")
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to start eBay OAuth", "error")
    } finally {
      setAddingStoreOAuth(false)
    }
  }

  const loadPolicies = useCallback(async (code: string) => {
    if (!code) return
    try {
      const res = await fetch(
        `${API_BASE}/admin/settings/policies?storeCode=${encodeURIComponent(code)}`,
        { cache: "no-store" }
      )
      if (!res.ok) {
        setPolicyOptions({ ...DEFAULT_POLICY_OPTIONS })
        return
      }
      const data: unknown = await res.json()
      setPolicyOptions(normalizePoliciesResponse(data))
    } catch {
      setPolicyOptions({ ...DEFAULT_POLICY_OPTIONS })
    }
  }, [])

  useEffect(() => {
    if (storesLoading || stores.length === 0) return
    if (!stores.some((r) => r.storeCode === selectedStore)) return
    loadPolicies(selectedStore)
  }, [selectedStore, stores, storesLoading, loadPolicies])

  const loadSettings = useCallback(async (code: string) => {
    if (!code) return
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/admin/settings?storeCode=${encodeURIComponent(code)}`, { cache: "no-store" })
      const data = (await res.json()) as SettingsResponse
      setSettings(data)
      const a = data.address
      if (a) {
        setLoc({
          firstName: a.firstName ?? "",
          lastName:  a.lastName ?? "",
          company:   a.company ?? "",
          address1:  a.address1 ?? "",
          address2:  a.address2 ?? "",
          city:      a.city ?? "",
          state:     a.state ?? "",
          zip:       a.zip ?? "",
          country:   toIso2Country(a.country, "US"),
          registrationCountry: toIso2Country(
            data.registrationCountry ?? a.country,
            "US"
          ),
        })
      } else {
        setLoc({
          ...emptyAddress(),
          country: toIso2Country(data.countryOrRegion, "US"),
        })
      }
      setReturnId(data.returnPolicyId ?? "")
      setFulfillmentId(data.fulfillmentPolicyId ?? "")
      setPaymentId(data.paymentPolicyId ?? "")
      setPricingMode(data.pricingMode ?? "PERCENTAGE_NET_PROFIT")
      setPercentageNetProfitPercent(
        typeof data.percentageNetProfitPercent === "number" && Number.isFinite(data.percentageNetProfitPercent)
          ? data.percentageNetProfitPercent.toString()
          : typeof data.markupPercent === "number" && Number.isFinite(data.markupPercent)
            ? data.markupPercent.toString()
          : "35"
      )
      setTieredProfitRows(rangesToFormRows(data.tieredProfitOverrides ?? []))
      setWarehouseBannerEnabled(data.warehouseShippingBannerEnabled === true)
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to load settings", "error")
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    if (storesLoading || stores.length === 0) return
    if (!stores.some((r) => r.storeCode === selectedStore)) return
    loadSettings(selectedStore)
  }, [selectedStore, stores, storesLoading, loadSettings])

  async function handleCreateStore() {
    const name = createStoreName.trim()
    const storeCode = createStoreCode.trim().toUpperCase()
    setCreateStoreError(null)

    if (!name) {
      setCreateStoreError("Store Name is required")
      return
    }
    if (!storeCode) {
      setCreateStoreError("Store Code is required")
      return
    }
    if (storeCode.length > 10) {
      setCreateStoreError("Store Code must be max 10 characters")
      return
    }

    setCreatingStore(true)
    try {
      const res = await fetch(`${API_BASE}/admin/stores/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, storeCode }),
      })
      if (!res.ok) throw new Error(await res.text())

      const created = (await res.json()) as AdminStoreRow
      setCreateStoreOpen(false)
      setCreateStoreName("")
      setCreateStoreCode("")

      await loadStores()
      setSelectedStore(created.storeCode)
    } catch (e) {
      setCreateStoreError(e instanceof Error ? e.message : "Create store failed")
    } finally {
      setCreatingStore(false)
    }
  }

  const locationValid =
    loc.firstName.trim() &&
    loc.lastName.trim() &&
    loc.address1.trim() &&
    loc.city.trim() &&
    loc.state.trim() &&
    loc.zip.trim() &&
    loc.country.trim()

  async function handleSaveLocation() {
    if (!selectedStore || !locationValid) return
    setSavingLocation(true)
    setSavedLocation(false)
    const countryIso = toIso2Country(loc.country, "US")
    const regIso = toIso2Country(loc.registrationCountry, countryIso)
    try {
      const res = await fetch(`${API_BASE}/admin/settings/address`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeCode: selectedStore,
          firstName: loc.firstName.trim(),
          lastName:  loc.lastName.trim(),
          company:   loc.company.trim() || null,
          address1:  loc.address1.trim(),
          address2:  loc.address2.trim() || null,
          city:      loc.city.trim(),
          state:     loc.state.trim(),
          zip:       loc.zip.trim(),
          country:   countryIso,
          registrationCountry: regIso || null,
        }),
      })
      if (!res.ok) {
        const t = await res.text()
        throw new Error(t || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as SettingsResponse
      setSettings(data)
      if (data.address) {
        const a = data.address
        setLoc((prev) => ({
          ...prev,
          firstName: a.firstName ?? "",
          lastName:  a.lastName ?? "",
          company:   a.company ?? "",
          address1:  a.address1 ?? "",
          address2:  a.address2 ?? "",
          city:      a.city ?? "",
          state:     a.state ?? "",
          zip:       a.zip ?? "",
          country:   toIso2Country(a.country, prev.country),
          registrationCountry: toIso2Country(
            data.registrationCountry ?? a.country,
            prev.registrationCountry
          ),
        }))
      }
      setSavedLocation(true)
      showToast("Settings saved successfully")
      setTimeout(() => setSavedLocation(false), 3000)
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Save failed", "error")
    } finally {
      setSavingLocation(false)
    }
  }

  async function handleSavePolicies() {
    if (!selectedStore) return
    setSavingPolicies(true)
    setSavedPolicies(false)
    try {
      const res = await fetch(`${API_BASE}/admin/settings/policies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeCode: selectedStore,
          returnPolicyId:      returnId || null,
          fulfillmentPolicyId: fulfillmentId || null,
          paymentPolicyId:     paymentId || null,
        }),
      })
      if (!res.ok) {
        const t = await res.text()
        throw new Error(t || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as SettingsResponse
      setSettings(data)
      setReturnId(data.returnPolicyId ?? "")
      setFulfillmentId(data.fulfillmentPolicyId ?? "")
      setPaymentId(data.paymentPolicyId ?? "")
      setSavedPolicies(true)
      showToast("Settings saved successfully")
      setTimeout(() => setSavedPolicies(false), 3000)
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Save failed", "error")
    } finally {
      setSavingPolicies(false)
    }
  }

  async function handleSavePricing() {
    if (!selectedStore) return
    const value = Number(percentageNetProfitPercent)
    if (!Number.isFinite(value) || value <= 0 || value > 1000) {
      showToast("Hedef net kâr yüzdesi 0 ile 1000 arasında olmalıdır", "error")
      return
    }
    const rangesResult = validatePricingRangeRows(tieredProfitRows)
    if (!rangesResult.ok) {
      showToast(rangesResult.error, "error")
      return
    }
    setSavingPricing(true)
    setSavedPricing(false)
    try {
      const res = await fetch(`${API_BASE}/admin/settings/pricing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeCode: selectedStore,
          pricingMode,
          percentageNetProfitPercent: value,
          tieredProfitOverrides: rangesResult.ranges,
        }),
      })
      if (!res.ok) {
        const t = await res.text()
        throw new Error(t || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as SettingsResponse
      setSettings(data)
      setTieredProfitRows(rangesToFormRows(data.tieredProfitOverrides ?? []))
      setSavedPricing(true)
      showToast("Settings saved successfully")
      setTimeout(() => setSavedPricing(false), 3000)
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Save failed", "error")
    } finally {
      setSavingPricing(false)
    }
  }

  async function handleSaveWarehouseBanner() {
    if (!selectedStore) return
    setSavingBanner(true)
    setSavedBanner(false)
    try {
      const res = await fetch(`${API_BASE}/admin/settings/warehouse-banner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeCode: selectedStore,
          warehouseShippingBannerEnabled: warehouseBannerEnabled,
        }),
      })
      if (!res.ok) {
        const t = await res.text()
        throw new Error(t || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as {
        ok?: boolean
        storeCode?: string
        warehouseShippingBannerEnabled?: boolean
      }
      if (typeof data.warehouseShippingBannerEnabled === "boolean") {
        setWarehouseBannerEnabled(data.warehouseShippingBannerEnabled)
      }
      setSavedBanner(true)
      showToast("Settings saved successfully")
      setTimeout(() => setSavedBanner(false), 3000)
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Save failed", "error")
    } finally {
      setSavingBanner(false)
    }
  }

  const inputClass = "w-full px-3 py-2 rounded border text-sm font-mono"
  const inputStyle = {
    background: "var(--bg)",
    borderColor: "var(--border)",
    color: "var(--text)",
  }
  const labelClass = "block text-xs font-mono uppercase tracking-wider mb-1 text-[var(--dim)]"
  const sectionTitle =
    "text-sm font-semibold font-mono uppercase tracking-wider mb-4 pb-2 border-b border-[var(--border)]"
  const sectionTitleStyle = { color: "var(--text)" }
  const grid2 = "grid grid-cols-1 sm:grid-cols-2 gap-4"

  const storesForTabs = stores

  return (
    <div className="max-w-2xl animate-fade-in">
      <h1 className="text-lg font-semibold mb-6" style={{ fontFamily: "'Syne', sans-serif", color: "var(--text)" }}>
        Settings
      </h1>

      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <p
            className="text-sm font-semibold font-mono uppercase tracking-wider"
            style={{ color: "var(--text)" }}
          >
            Mağaza yönetimi
          </p>

          <button
            type="button"
            onClick={() => {
              setCreateStoreError(null)
              setCreateStoreOpen(true)
            }}
            disabled={storesLoading}
            className="px-3 py-2 rounded text-sm font-mono font-semibold uppercase tracking-wider transition-opacity disabled:opacity-50 border border-[var(--border)]"
            style={{ background: "transparent", color: "var(--sub)" }}
          >
            Manual create
          </button>
        </div>

        {storesLoading ? (
          <p className="text-sm font-mono text-[var(--dim)]">Loading stores...</p>
        ) : storesForTabs.length === 0 ? (
          <p className="text-sm font-mono text-[var(--dim)]">
            No stores yet. Use + Add Store below to connect eBay, or Manual create.
          </p>
        ) : (
          <div
            className="flex flex-nowrap gap-1 p-1 rounded bg-[var(--surface)] border border-[var(--border)] overflow-x-auto"
          >
            {storesForTabs.map((s) => {
              const tabLabel = s.name?.trim() || "Store"
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedStore(s.storeCode)}
                  className="max-w-[160px] min-w-0 shrink-0 truncate py-2 px-3 rounded text-sm font-mono font-medium transition-colors"
                  style={{
                    background: selectedStore === s.storeCode ? "var(--accent)" : "transparent",
                    color: selectedStore === s.storeCode ? "#000" : "var(--sub)",
                  }}
                  title={tabLabel}
                >
                  {tabLabel}
                </button>
              )
            })}
          </div>
        )}

        <div className="mt-3">
          <button
            type="button"
            onClick={() => { void handleAddStore() }}
            disabled={storesLoading || addingStoreOAuth}
            className="px-3 py-2 rounded text-sm font-mono font-semibold uppercase tracking-wider transition-opacity disabled:opacity-50"
            style={{ background: "var(--accent)", color: "#000" }}
          >
            {addingStoreOAuth ? "Opening eBay…" : "+ Add Store"}
          </button>
        </div>

        {settings?.storeName && (
          <p className="mt-1.5 text-xs font-mono text-[var(--dim)]">{settings.storeName}</p>
        )}
      </section>

      {createStoreOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => {
            setCreateStoreOpen(false)
            setCreateStoreError(null)
            setCreateStoreName("")
            setCreateStoreCode("")
          }}
        >
          <div
            className="w-full max-w-md rounded border p-5"
            style={{ background: "var(--surface)", borderColor: "var(--border)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2
                className="text-sm font-semibold font-mono uppercase tracking-wider"
                style={{ color: "var(--text)" }}
              >
                Add Store
              </h2>
              <button
                type="button"
                className="text-sm font-mono"
                style={{ color: "var(--dim)" }}
                onClick={() => {
                  setCreateStoreOpen(false)
                  setCreateStoreError(null)
                  setCreateStoreName("")
                  setCreateStoreCode("")
                }}
              >
                ×
              </button>
            </div>

            {createStoreError && (
              <div
                className="mb-4 p-3 rounded text-sm font-mono"
                style={{
                  background: "rgba(255,68,85,0.08)",
                  border: "1px solid rgba(255,68,85,0.25)",
                  color: "var(--danger)",
                }}
              >
                {createStoreError}
              </div>
            )}

            <div className="mb-4">
              <label className={labelClass}>Store Name</label>
              <input
                type="text"
                className={inputClass}
                style={inputStyle}
                value={createStoreName}
                onChange={(e) => setCreateStoreName(e.target.value)}
                autoComplete="organization"
              />
            </div>

            <div className="mb-6">
              <label className={labelClass}>Store Code</label>
              <input
                type="text"
                className={inputClass}
                style={inputStyle}
                value={createStoreCode}
                onChange={(e) =>
                  setCreateStoreCode(e.target.value.toUpperCase().slice(0, 10))
                }
                maxLength={10}
                autoComplete="off"
              />
              <p className="mt-1 text-[11px] font-mono" style={{ color: "var(--dim)" }}>
                Uppercase, max 10 chars
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                void handleCreateStore()
              }}
              disabled={
                creatingStore ||
                !createStoreName.trim() ||
                !createStoreCode.trim()
              }
              className="w-full px-4 py-2 rounded text-sm font-mono font-semibold uppercase tracking-wider transition-opacity disabled:opacity-50"
              style={{ background: "var(--accent)", color: "#000" }}
            >
              {creatingStore ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      )}

      {stores.length === 0 || storesLoading ? null : loading ? (
        <p className="text-sm font-mono text-[var(--dim)]">Loading...</p>
      ) : (
        <>
          <section
            className="p-5 rounded border mb-8"
            style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          >
            <h2 className={sectionTitle} style={sectionTitleStyle}>
              BÖLÜM 1 — LOCATION
            </h2>

            <div className={grid2 + " mb-4"}>
              <div>
                <label className={labelClass}>First name</label>
                <input
                  type="text"
                  className={inputClass}
                  style={inputStyle}
                  value={loc.firstName}
                  onChange={(e) => setLoc((p) => ({ ...p, firstName: e.target.value }))}
                  autoComplete="given-name"
                />
              </div>
              <div>
                <label className={labelClass}>Last name</label>
                <input
                  type="text"
                  className={inputClass}
                  style={inputStyle}
                  value={loc.lastName}
                  onChange={(e) => setLoc((p) => ({ ...p, lastName: e.target.value }))}
                  autoComplete="family-name"
                />
              </div>
            </div>

            <div className="mb-4">
              <label className={labelClass}>Company (optional)</label>
              <input
                type="text"
                className={inputClass}
                style={inputStyle}
                value={loc.company}
                onChange={(e) => setLoc((p) => ({ ...p, company: e.target.value }))}
                autoComplete="organization"
              />
            </div>

            <div className="mb-4">
              <label className={labelClass}>Address line 1</label>
              <input
                type="text"
                className={inputClass}
                style={inputStyle}
                value={loc.address1}
                onChange={(e) => setLoc((p) => ({ ...p, address1: e.target.value }))}
                autoComplete="address-line1"
              />
            </div>

            <div className="mb-4">
              <label className={labelClass}>Address line 2 (optional)</label>
              <input
                type="text"
                className={inputClass}
                style={inputStyle}
                value={loc.address2}
                onChange={(e) => setLoc((p) => ({ ...p, address2: e.target.value }))}
                autoComplete="address-line2"
              />
            </div>

            <div className={grid2 + " mb-4"}>
              <div>
                <label className={labelClass}>City</label>
                <input
                  type="text"
                  className={inputClass}
                  style={inputStyle}
                  value={loc.city}
                  onChange={(e) => setLoc((p) => ({ ...p, city: e.target.value }))}
                  autoComplete="address-level2"
                />
              </div>
              <div>
                <label className={labelClass}>State / Province</label>
                <input
                  type="text"
                  className={inputClass}
                  style={inputStyle}
                  value={loc.state}
                  onChange={(e) => setLoc((p) => ({ ...p, state: e.target.value }))}
                  autoComplete="address-level1"
                />
              </div>
            </div>

            <div className={grid2 + " mb-4"}>
              <div>
                <label className={labelClass}>Postcode</label>
                <input
                  type="text"
                  className={inputClass}
                  style={inputStyle}
                  value={loc.zip}
                  onChange={(e) => setLoc((p) => ({ ...p, zip: e.target.value }))}
                  autoComplete="postal-code"
                />
              </div>
              <div>
                <label className={labelClass}>Country</label>
                <select
                  className={inputClass}
                  style={inputStyle}
                  value={loc.country}
                  onChange={(e) => setLoc((p) => ({ ...p, country: e.target.value }))}
                >
                  {COUNTRY_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mb-4">
              <label className={labelClass}>Registration country / Overseas policy</label>
              <select
                className={inputClass}
                style={inputStyle}
                value={loc.registrationCountry}
                onChange={(e) => setLoc((p) => ({ ...p, registrationCountry: e.target.value }))}
              >
                {COUNTRY_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={handleSaveLocation}
              disabled={savingLocation || !locationValid}
              className="px-4 py-2 rounded text-sm font-mono font-semibold uppercase tracking-wider transition-opacity disabled:opacity-50"
              style={{ background: "var(--accent)", color: "#000" }}
            >
              {savingLocation ? "Saving..." : savedLocation ? "Saved" : "Save"}
            </button>
          </section>

          <section
            className="p-5 rounded border"
            style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          >
            <h2 className={sectionTitle} style={sectionTitleStyle}>
              BÖLÜM 2 — POLICIES
            </h2>
            <div className="mb-4">
              <label className={labelClass}>Return Policy</label>
              <select
                className={inputClass}
                style={inputStyle}
                value={returnId}
                onChange={(e) => setReturnId(e.target.value)}
              >
                <option value="">— Select —</option>
                {effectivePolicyOptions.returnPolicies.map((p) => (
                  <option key={p.id} value={p.id}>{p.name || p.id}</option>
                ))}
              </select>
            </div>
            <div className="mb-4">
              <label className={labelClass}>Fulfillment Policy</label>
              <select
                className={inputClass}
                style={inputStyle}
                value={fulfillmentId}
                onChange={(e) => setFulfillmentId(e.target.value)}
              >
                <option value="">— Select —</option>
                {effectivePolicyOptions.fulfillmentPolicies.map((p) => (
                  <option key={p.id} value={p.id}>{p.name || p.id}</option>
                ))}
              </select>
            </div>
            <div className="mb-4">
              <label className={labelClass}>Payment Policy</label>
              <select
                className={inputClass}
                style={inputStyle}
                value={paymentId}
                onChange={(e) => setPaymentId(e.target.value)}
              >
                <option value="">— Select —</option>
                {effectivePolicyOptions.paymentPolicies.map((p) => (
                  <option key={p.id} value={p.id}>{p.name || p.id}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={handleSavePolicies}
              disabled={savingPolicies}
              className="px-4 py-2 rounded text-sm font-mono font-semibold uppercase tracking-wider transition-opacity disabled:opacity-50"
              style={{ background: "var(--accent)", color: "#000" }}
            >
              {savingPolicies ? "Saving..." : savedPolicies ? "Saved" : "Save"}
            </button>
          </section>

          <section className="p-5 rounded border mt-8" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
            <h2 className={sectionTitle} style={sectionTitleStyle}>BÖLÜM 3 — PRICING</h2>
            <label className={labelClass}>Pricing Method</label>
            <div className="grid gap-3 mb-5 md:grid-cols-2">
              {([
                ["PERCENTAGE_NET_PROFIT", "Yüzdesel Net Kâr", "Amazon maliyetinin belirlediğiniz yüzdesi kadar net kâr hedeflenir."],
                ["TIERED_MIN_NET_PROFIT", "Kademeli Minimum Net Kâr", "Manuel fiyat aralıkları için minimum net kâr; aralık dışı ürünlerde yüzde kâr payı kullanılır."],
              ] as const).map(([mode, title, description]) => (
                <button key={mode} type="button" onClick={() => setPricingMode(mode)}
                  className="p-4 rounded border text-left"
                  style={{ borderColor: pricingMode === mode ? "var(--accent)" : "var(--border)", background: pricingMode === mode ? "rgba(0,255,136,0.07)" : "transparent" }}>
                  <span className="block text-sm font-semibold">{title}</span>
                  <span className="block mt-1 text-xs" style={{ color: "var(--dim)" }}>{description}</span>
                </button>
              ))}
            </div>

            <div className="mb-5">
              <label className={labelClass} style={{ display: "inline-flex", alignItems: "center" }}>
                Percentage Net Profit (%)
                <InfoTooltip text="Profit belirlemediğiniz fiyat aralıklarındaki ürünleriniz, buraya girdiğiniz kâr payı yüzdesi kullanılarak listelenir." />
              </label>
              <input type="number" min={0.01} max={1000} step={0.01} className={inputClass} style={inputStyle}
                value={percentageNetProfitPercent} onChange={(e) => setPercentageNetProfitPercent(e.target.value)} />
              {pricingMode === "PERCENTAGE_NET_PROFIT" && Number(percentageNetProfitPercent) > 0 && (
                <div className="mt-4 p-3 rounded border text-xs font-mono" style={{ borderColor: "var(--border)" }}>
                  <div>Örnek — Amazon cost: $10.00</div>
                  <div>Target net profit: ${(10 * Number(percentageNetProfitPercent) / 100).toFixed(2)}</div>
                  <div>Estimated eBay listing price: ${estimatedListingPrice(10, 10 * Number(percentageNetProfitPercent) / 100).toFixed(2)}</div>
                </div>
              )}
            </div>

            {pricingMode === "TIERED_MIN_NET_PROFIT" && (
              <div className="mb-5">
                <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 mb-2 text-xs font-semibold" style={{ color: "var(--dim)" }}>
                  <span>Amazon Min ($)</span>
                  <span>Amazon Max ($)</span>
                  <span>Min Net Profit ($)</span>
                  <span />
                </div>
                {tieredProfitRows.map((row, index) => (
                  <div key={index} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center mb-2">
                    <input type="number" min={0} step={0.01} className={inputClass} style={inputStyle} value={row.minPrice}
                      onChange={(e) => setTieredProfitRows(prev => prev.map((r, i) => i === index ? { ...r, minPrice: e.target.value } : r))} />
                    <input type="number" min={0} step={0.01} className={inputClass} style={inputStyle} value={row.maxPrice}
                      onChange={(e) => setTieredProfitRows(prev => prev.map((r, i) => i === index ? { ...r, maxPrice: e.target.value } : r))} />
                    <input type="number" min={0} step={0.01} className={inputClass} style={inputStyle} value={row.minNetProfit}
                      onChange={(e) => setTieredProfitRows(prev => prev.map((r, i) => i === index ? { ...r, minNetProfit: e.target.value } : r))} />
                    <button type="button" className="text-xs underline px-1" aria-label="Delete"
                      onClick={() => setTieredProfitRows(prev => prev.filter((_, i) => i !== index))}>Sil</button>
                  </div>
                ))}
                <button
                  type="button"
                  className="mt-2 mb-4 px-3 py-2 rounded border text-xs font-semibold"
                  style={{ borderColor: "rgba(0,255,136,0.35)", color: "var(--accent)" }}
                  onClick={() => setTieredProfitRows(prev => [...prev, emptyPricingRangeRow()])}
                >
                  + Add price range
                </button>
              </div>
            )}

            <div className="mb-5 p-3 rounded text-xs font-mono leading-relaxed" style={{ background: "var(--bg)", color: "var(--dim)" }}>
              <div className="font-semibold" style={{ color: "var(--text)" }}>Pricing assumptions</div>
              <div>Estimated eBay percentage fee: 17.1%</div><div>Buyer sales-tax assumption: 9%</div>
              <div>Fixed eBay fee reserve: $0.50</div><div>Promoted Listings / advertising fees: not included</div>
            </div>
            <button type="button" onClick={handleSavePricing} disabled={savingPricing}
              className="px-4 py-2 rounded text-sm font-mono font-semibold uppercase tracking-wider disabled:opacity-50"
              style={{ background: "var(--accent)", color: "#000" }}>
              {savingPricing ? "Saving..." : savedPricing ? "Saved" : "Save"}
            </button>
          </section>

          <section
            className="p-5 rounded border mt-8"
            style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          >
            <h2 className={sectionTitle} style={sectionTitleStyle}>
              BÖLÜM — WAREHOUSE SHIPPING BANNER
            </h2>
            <p className="text-xs font-mono mb-4 leading-relaxed" style={{ color: "var(--dim)" }}>
              Bu özellik aktif olduğunda, ürün yükleme sırasında ana ürün görsellerinin altına ABD
              deposu ve hızlı teslimat bilgisini gösteren koyu renkli bir şerit eklenir. Sadece
              overseas warehouse / depo onayı alınmış mağazalarda kullanılmalıdır.
            </p>

            <label className="flex items-start gap-3 mb-5 cursor-pointer">
              <input
                type="checkbox"
                checked={warehouseBannerEnabled}
                onChange={(e) => setWarehouseBannerEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              <span className="text-sm font-mono" style={{ color: "var(--text)" }}>
                Ships from USA banner aktif
              </span>
            </label>

            <div className="mb-4">
              <p className={labelClass}>Preview</p>
              <div
                className="relative mx-auto overflow-hidden rounded border"
                style={{
                  width: 220,
                  height: 220,
                  borderColor: "var(--border)",
                  opacity: warehouseBannerEnabled ? 1 : 0.55,
                }}
              >
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  style={{ background: "#f3f4f6" }}
                >
                  <span className="text-xs font-mono" style={{ color: "#9ca3af" }}>
                    Product image
                  </span>
                </div>
                {warehouseBannerEnabled ? (
                  <div
                    className="absolute bottom-0 left-0 right-0 flex items-center justify-center px-2 py-2"
                    style={{ background: "#0f172a" }}
                  >
                    <span
                      className="text-center font-mono font-semibold leading-tight"
                      style={{ color: "#ffffff", fontSize: 9 }}
                    >
                      Ships from USA • No Import Fees • 2–3 Day Delivery
                    </span>
                  </div>
                ) : (
                  <div
                    className="absolute inset-0 flex items-center justify-center"
                    style={{ background: "rgba(0,0,0,0.35)" }}
                  >
                    <span
                      className="rounded px-2 py-1 text-xs font-mono font-semibold uppercase tracking-wider"
                      style={{ background: "var(--surface)", color: "var(--dim)" }}
                    >
                      Banner kapalı
                    </span>
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={handleSaveWarehouseBanner}
              disabled={savingBanner}
              className="px-4 py-2 rounded text-sm font-mono font-semibold uppercase tracking-wider transition-opacity disabled:opacity-50"
              style={{ background: "var(--accent)", color: "#000" }}
            >
              {savingBanner ? "Saving..." : savedBanner ? "Saved" : "Save"}
            </button>
          </section>

          <section
            className="p-5 rounded border mt-8"
            style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          >
            <h2 className={sectionTitle} style={sectionTitleStyle}>
              BÖLÜM 4 — EBAY CONNECTION
            </h2>
            <EbayConnectSection
              storeCode={selectedStore}
              storeDisplayName={stores.find((x) => x.storeCode === selectedStore)?.name}
              onDisconnected={async () => {
                await loadStores()
                showToast("Store removed.")
              }}
            />
          </section>
        </>
      )}
    </div>
  )
}
