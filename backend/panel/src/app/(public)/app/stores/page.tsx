"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { fetchAuthMe, type UserPublic } from "@/lib/userAuthClient"
import {
  fetchAppEbayStatus,
  fetchAppStores,
  startAppEbayConnect,
  type AppStoreSummary,
} from "@/lib/userAppClient"
import { useFocusRefetch } from "@/components/app/useFocusRefetch"
import {
  KpiBellIcon,
  KpiCheckIcon,
  KpiListIcon,
  KpiStoreIcon,
  KpiWarnIcon,
  StoreCard,
  StoreKpiCard,
  fmtInt,
  fmtTokenStamp,
} from "@/components/stores/StoresWidgets"

type OAuthBanner = { type: "success" | "error"; text: string }

export default function AppStoresPage() {
  const router = useRouter()
  const [user, setUser] = useState<UserPublic | null>(null)
  const [stores, setStores] = useState<AppStoreSummary[]>([])
  const [ebayConnected, setEbayConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [oauthBanner, setOauthBanner] = useState<OAuthBanner | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("ebayConnected") === "1") {
      setOauthBanner({ type: "success", text: "eBay store connected successfully." })
    } else if (params.get("ebayError")) {
      setOauthBanner({ type: "error", text: "eBay connection failed. Please try again." })
    }
  }, [])

  const fetchStoresData = useCallback(async (): Promise<boolean> => {
    const [storesResult, ebayResult] = await Promise.all([
      fetchAppStores(),
      fetchAppEbayStatus(),
    ])

    if (
      (!storesResult.ok && storesResult.status === 401) ||
      (!ebayResult.ok && ebayResult.status === 401)
    ) {
      router.replace("/app/login")
      return false
    }

    if (
      (!storesResult.ok && storesResult.status === 403 && storesResult.approvalStatus === "pending_approval") ||
      (!ebayResult.ok && ebayResult.status === 403 && ebayResult.approvalStatus === "pending_approval")
    ) {
      router.replace("/pending-approval")
      return false
    }

    let ok = true
    if (storesResult.ok) {
      setStores(storesResult.data.stores)
    } else {
      ok = false
    }
    if (ebayResult.ok) {
      setEbayConnected(ebayResult.data.connected)
    } else {
      ok = false
    }

    return ok
  }, [router])

  const load = useCallback(async () => {
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

    const ok = await fetchStoresData()
    if (!ok) {
      setError("Could not refresh store data.")
    }
    setLoading(false)
  }, [router, fetchStoresData])

  const refreshStoresData = useCallback(async () => {
    if (connecting) return
    setRefreshing(true)
    const ok = await fetchStoresData()
    if (!ok) {
      setError(prev => prev ?? "Could not refresh store data.")
    }
    setRefreshing(false)
  }, [connecting, fetchStoresData])

  useFocusRefetch(refreshStoresData, { enabled: !loading && !connecting })

  useEffect(() => {
    void load()
  }, [load])

  async function handleConnectEbay() {
    setConnecting(true)
    setError(null)
    const result = await startAppEbayConnect()
    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      setError(result.error)
      setConnecting(false)
      return
    }
    window.location.href = result.data.authUrl
  }

  const stats = useMemo(() => {
    const connected = stores.filter(s => s.connected)
    const healthy = connected.filter(s => s.connectionHint === "connected")
    const listingTotal = stores.reduce((sum, s) => sum + (s.listingCount || 0), 0)
    const needsAsinTotal = stores.reduce((sum, s) => sum + (s.needsAsinCount || 0), 0)
    const alertsTotal = stores.reduce((sum, s) => sum + (s.stockAlertsCount || 0), 0)
    const earliest = stores
      .map(s => s.ebayExpiresAt)
      .filter((v): v is string => Boolean(v?.trim()))
      .map(v => ({ raw: v, t: new Date(v).getTime() }))
      .filter(v => Number.isFinite(v.t))
      .sort((a, b) => a.t - b.t)[0]
    const needsParts = stores.map(s => fmtInt(s.needsAsinCount)).join(" + ")
    return {
      connectedCount: connected.length,
      healthyCount: healthy.length,
      listingTotal,
      needsAsinTotal,
      alertsTotal,
      earliestStamp: earliest ? fmtTokenStamp(earliest.raw) : null,
      needsHint: stores.length > 0 ? `${needsParts} across stores` : "Across connected stores",
      activeHint:
        connected.length > 0 && healthy.length === connected.length
          ? "All Connected · active"
          : connected.length === 0
            ? "No connected stores"
            : `${fmtInt(healthy.length)} of ${fmtInt(connected.length)} connected`,
      alertsHint: alertsTotal === 0 ? "No pending alerts" : "Across connected stores",
    }
  }, [stores])

  if (loading) {
    return <div className="lj-stores-loading">Loading…</div>
  }

  if (!user) return null

  const hasStores = stores.length > 0
  void ebayConnected

  return (
    <div className="lj-stores">
      <header className="lj-stores-header">
        <div className="lj-stores-title-block">
          <Link href="/app/dashboard" className="lj-stores-crumb">
            Dashboard / Stores
          </Link>
          <div className="lj-stores-title-row">
            <h1 className="lj-stores-title">Your eBay Stores</h1>
            {refreshing && <span className="lj-stores-refreshing">Refreshing…</span>}
          </div>
          <p className="lj-stores-sub">
            {hasStores
              ? "Manage your connected eBay stores, listings, and alerts."
              : "Connect your eBay store to start importing listings, monitoring source prices, and protecting your profit."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleConnectEbay()}
          disabled={connecting}
          className="lj-stores-connect"
        >
          {connecting ? "Connecting…" : "+ eBay Mağazası Bağla"}
        </button>
      </header>

      {oauthBanner && (
        <div className={`lj-stores-banner ${oauthBanner.type === "success" ? "lj-stores-banner--ok" : "lj-stores-banner--err"}`}>
          {oauthBanner.text}
        </div>
      )}

      {error && (
        <div className="lj-stores-error">
          <p>{error}</p>
          <button type="button" onClick={() => void load()} className="lj-stores-retry">
            Retry
          </button>
        </div>
      )}

      <aside className="lj-stores-info" aria-label="How it works">
        <span className="lj-stores-info-dot" aria-hidden="true" />
        <div className="lj-stores-info-copy">
          <p className="lj-stores-info-title">How it works</p>
          <p className="lj-stores-info-body">
            Connected stores are isolated to your workspace. Other users cannot access your store data.
          </p>
        </div>
      </aside>

      {!hasStores ? (
        <div className="lj-stores-empty">
          <p className="lj-stores-empty-title">No connected stores</p>
          <p className="lj-stores-empty-body">Use + eBay Mağazası Bağla to connect an eBay store.</p>
        </div>
      ) : (
        <>
          <div className="lj-stores-kpis">
            <StoreKpiCard
              label="Connected Stores"
              value={fmtInt(stats.connectedCount)}
              hint="From current workspace"
              icon={<KpiStoreIcon />}
            />
            <StoreKpiCard
              label="Total Listings"
              value={fmtInt(stats.listingTotal)}
              hint="Sum of connected stores"
              icon={<KpiListIcon />}
            />
            <StoreKpiCard
              label="Active Connections"
              value={`${fmtInt(stats.healthyCount)} / ${fmtInt(stats.connectedCount)}`}
              hint={stats.activeHint}
              icon={<KpiCheckIcon />}
            />
            <StoreKpiCard
              label="Needs ASIN"
              value={fmtInt(stats.needsAsinTotal)}
              hint={stats.needsHint}
              tone="warn"
              icon={<KpiWarnIcon />}
            />
            <StoreKpiCard
              label="Pending Alerts"
              value={fmtInt(stats.alertsTotal)}
              hint={stats.alertsHint}
              tone="muted"
              icon={<KpiBellIcon />}
            />
          </div>

          <div className="lj-stores-health">
            <div className="lj-stores-health-cell">
              <span className="lj-stores-health-label">Stores connected</span>
              <div className="lj-stores-health-value">
                <span className="lj-stores-dot lj-stores-dot--green" aria-hidden="true" />
                <span>{fmtInt(stats.connectedCount)}</span>
              </div>
            </div>
            <div className="lj-stores-health-cell">
              <span className="lj-stores-health-label">Healthy connections</span>
              <div className="lj-stores-health-value">
                <span className="lj-stores-dot lj-stores-dot--green" aria-hidden="true" />
                <span>{fmtInt(stats.healthyCount)} / {fmtInt(stats.connectedCount)}</span>
              </div>
            </div>
            <div className="lj-stores-health-cell">
              <span className="lj-stores-health-label">Earliest token expiry</span>
              <div className="lj-stores-health-value">
                <span className="lj-stores-dot lj-stores-dot--neutral" aria-hidden="true" />
                <span>{stats.earliestStamp ?? "—"}</span>
              </div>
            </div>
            <div className="lj-stores-health-cell">
              <span className="lj-stores-health-label">Pending alerts</span>
              <div className="lj-stores-health-value">
                <span className="lj-stores-dot lj-stores-dot--green" aria-hidden="true" />
                <span>{fmtInt(stats.alertsTotal)}</span>
              </div>
            </div>
          </div>

          <div className="lj-stores-grid">
            {stores.map(s => (
              <StoreCard key={s.storeCode} store={s} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
