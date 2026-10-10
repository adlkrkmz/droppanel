"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { fetchAuthMe, type UserPublic } from "@/lib/userAuthClient"
import {
  fetchAppDashboard,
  fetchAppDashboardOps,
  fetchAppEbayStatus,
  fetchAppStores,
  startAppEbayConnect,
  type AppDashboardOpsResponse,
  type AppDashboardResponse,
  type AppEbayStatusResponse,
  type AppStoreSummary,
} from "@/lib/userAppClient"
import {
  ChecklistLink,
  OnboardingChecklist,
  checklistPrimaryBtnStyle,
  type ChecklistStep,
} from "@/components/app/OnboardingChecklist"
import { useFocusRefetch } from "@/components/app/useFocusRefetch"
import { storeCodeForId, useAppStoreSelection } from "@/lib/appStoreSelection"
import {
  CustomerServiceSummary,
  DashboardKpiCard,
  DashboardMetric,
  DashboardSection,
  DashboardStoreSelect,
  DashboardTable,
  KpiBarsIcon,
  KpiWarnIcon,
  ListingHealthList,
  NeedsAttentionList,
  OrderPipelineList,
  RecentActivityList,
  dashCard,
  fmtInt,
  moneyUsd,
} from "@/components/dashboard/DashboardWidgets"

type OAuthBanner = { type: "success" | "error"; text: string }
type FinanceTab = "today" | "week" | "month"

export default function AppDashboardPage() {
  const router = useRouter()
  const { selectedStoreId, setSelectedStoreId, isStoreSelectionReady } = useAppStoreSelection()
  const [user, setUser] = useState<UserPublic | null>(null)
  const [dashboard, setDashboard] = useState<AppDashboardResponse | null>(null)
  const [ops, setOps] = useState<AppDashboardOpsResponse | null>(null)
  const [stores, setStores] = useState<AppStoreSummary[]>([])
  const [ebayStatus, setEbayStatus] = useState<AppEbayStatusResponse | null>(null)
  const [viewAllStores, setViewAllStores] = useState(false)
  const [financeTab, setFinanceTab] = useState<FinanceTab>("today")
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

  const selectedCode = storeCodeForId(stores, selectedStoreId) || stores[0]?.storeCode || ""

  const fetchDashboardData = useCallback(async (): Promise<boolean> => {
    const [dashResult, ebayResult, storesResult] = await Promise.all([
      fetchAppDashboard(),
      fetchAppEbayStatus(),
      fetchAppStores(),
    ])

    if (
      (!dashResult.ok && dashResult.status === 401) ||
      (!ebayResult.ok && ebayResult.status === 401) ||
      (!storesResult.ok && storesResult.status === 401)
    ) {
      router.replace("/app/login")
      return false
    }

    if (
      (!dashResult.ok && dashResult.status === 403 && dashResult.approvalStatus === "pending_approval") ||
      (!ebayResult.ok && ebayResult.status === 403 && ebayResult.approvalStatus === "pending_approval") ||
      (!storesResult.ok && storesResult.status === 403 && storesResult.approvalStatus === "pending_approval")
    ) {
      router.replace("/pending-approval")
      return false
    }

    let ok = true
    if (dashResult.ok) setDashboard(dashResult.data)
    else ok = false
    if (ebayResult.ok) setEbayStatus(ebayResult.data)
    else ok = false
    if (storesResult.ok) setStores(storesResult.data.stores)
    else ok = false
    return ok
  }, [router])

  const loadOps = useCallback(async () => {
    if (!isStoreSelectionReady) return
    if (!viewAllStores && !selectedCode) {
      setOps(null)
      return
    }
    setOps(null)
    const res = await fetchAppDashboardOps(
      viewAllStores ? { allStores: true, period: financeTab } : { storeCode: selectedCode, period: financeTab }
    )
    if (res.ok) setOps(res.data)
  }, [isStoreSelectionReady, viewAllStores, selectedCode, financeTab])

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
    const ok = await fetchDashboardData()
    if (!ok) setError("Could not refresh dashboard data.")
    setLoading(false)
  }, [router, fetchDashboardData])

  const refreshDashboardData = useCallback(async () => {
    if (connecting) return
    setRefreshing(true)
    const ok = await fetchDashboardData()
    await loadOps()
    if (!ok) setError(prev => prev ?? "Could not refresh dashboard data.")
    setRefreshing(false)
  }, [connecting, fetchDashboardData, loadOps])

  useFocusRefetch(refreshDashboardData, { enabled: !loading && !connecting })

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadOps()
  }, [loadOps])

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

  const summary = dashboard?.summary
  const onboarding = dashboard?.onboarding
  const storeCount = summary?.storeCount ?? 0
  const listingCount = summary?.listingCount ?? 0
  const pendingAlerts = summary?.pendingStockAlerts ?? 0
  const needsAsinCount = summary?.needsAsinCount ?? 0
  const connected = ebayStatus?.connected === true
  const hasStore = storeCount > 0
  const hasListings = listingCount > 0
  const setupIncomplete = Boolean(
    onboarding?.needsEbayConnect || onboarding?.needsImport || onboarding?.needsSettings || !connected
  )

  const checklistSteps = useMemo((): ChecklistStep[] => {
    const connectDone = connected
    const settingsDone = hasStore
    const importDone = hasListings
    const asinDone = hasListings && needsAsinCount === 0
    const alertsDone = hasListings && pendingAlerts === 0
    const asinImportHref =
      stores.find(s => s.needsAsinCount > 0)?.storeCode != null
        ? `/app/import?storeCode=${encodeURIComponent(stores.find(s => s.needsAsinCount > 0)!.storeCode)}&mode=asin-match`
        : stores.length === 1
          ? `/app/import?storeCode=${encodeURIComponent(stores[0]!.storeCode)}&mode=asin-match`
          : "/app/import?mode=asin-match"
    const completions = [connectDone, settingsDone, importDone, asinDone, alertsDone]
    const nextIndex = completions.findIndex(done => !done)
    const markNext = (index: number): boolean => nextIndex === index
    return [
      {
        id: "connect",
        title: "Connect eBay Store",
        description: "Link your eBay account so ListJetGo can sync listings and monitor source prices.",
        state: connectDone ? "completed" : "pending",
        statusLabel: connectDone ? "Completed" : "Pending",
        isNext: markNext(0),
        action: connectDone ? (
          <ChecklistLink href="/app/stores">Manage Stores</ChecklistLink>
        ) : (
          <button
            type="button"
            onClick={() => void handleConnectEbay()}
            disabled={connecting}
            style={{
              ...checklistPrimaryBtnStyle,
              background: connecting ? "var(--dim)" : checklistPrimaryBtnStyle.background,
              cursor: connecting ? "not-allowed" : "pointer",
            }}
          >
            {connecting ? "Connecting…" : "Connect eBay Store"}
          </button>
        ),
      },
      {
        id: "settings",
        title: "Configure Settings",
        description: "Set markup, warehouse address, policies, and banner options for your store.",
        state: settingsDone ? "completed" : "pending",
        statusLabel: settingsDone ? "Completed" : "Pending",
        isNext: markNext(1),
        action: (
          <ChecklistLink href={hasStore ? "/app/settings" : "/app/stores"}>
            {hasStore ? "Store Settings" : "Manage Stores"}
          </ChecklistLink>
        ),
      },
      {
        id: "import",
        title: "Import Listings",
        description: "Sync active eBay listings into ListJetGo. Existing records are updated, not duplicated.",
        state: importDone ? "completed" : "pending",
        statusLabel: importDone ? "Completed" : "Pending",
        isNext: markNext(2),
        action: importDone ? (
          <ChecklistLink href="/app/listings">View Listings</ChecklistLink>
        ) : hasStore ? (
          <ChecklistLink href="/app/import">Import Listings</ChecklistLink>
        ) : (
          <ChecklistLink href="/app/stores">Manage Stores</ChecklistLink>
        ),
      },
      {
        id: "asin",
        title: "Link Amazon ASINs",
        description: "Match eBay listings to Amazon source products so we can track price and stock risks.",
        state: asinDone ? "completed" : "pending",
        statusLabel: !hasListings ? "Import first" : asinDone ? "Completed" : "Needs ASINs",
        isNext: markNext(3),
        action: asinDone ? (
          <ChecklistLink href="/app/listings">View Listings</ChecklistLink>
        ) : hasListings ? (
          <ChecklistLink href={asinImportHref}>Link Amazon ASINs</ChecklistLink>
        ) : hasStore ? (
          <ChecklistLink href="/app/import">Import Listings</ChecklistLink>
        ) : (
          <ChecklistLink href="/app/stores">Manage Stores</ChecklistLink>
        ),
      },
      {
        id: "alerts",
        title: "Review Alerts",
        description: "Check source price increases, stock risks, and items that need your attention.",
        state: alertsDone ? "completed" : "pending",
        statusLabel: alertsDone ? "No pending alerts" : hasListings ? `${pendingAlerts} pending` : "Pending",
        isNext: markNext(4),
        action: hasStore ? (
          <ChecklistLink href="/app/stock-alerts">Review Stock Alerts</ChecklistLink>
        ) : (
          <ChecklistLink href="/app/stores">Manage Stores</ChecklistLink>
        ),
      },
    ]
  }, [connected, hasStore, hasListings, needsAsinCount, pendingAlerts, connecting, stores])

  if (loading) {
    return <div style={{ padding: 48, textAlign: "center", color: "var(--dim)" }}>Loading…</div>
  }
  if (!user) return null

  const finance = ops?.finance[financeTab]
  const periodLabel = financeTab === "today" ? "Today" : financeTab === "week" ? "7 Days" : "30 Days"
  const needsAttentionValue = viewAllStores
    ? ops?.kpis.storesWithIssues
    : ops?.kpis.needsAttention
  const missingCosts = finance ? Math.max(0, finance.costTotalCount - finance.costKnownCount) : 0
  const completenessPct =
    finance && finance.costTotalCount > 0
      ? `${Math.round((finance.costKnownCount / finance.costTotalCount) * 100)}%`
      : "—"
  const attentionCount =
    typeof needsAttentionValue === "number" && Number.isFinite(needsAttentionValue) ? needsAttentionValue : null

  return (
    <div className="dash-ops">
      <header className="dash-ops-header">
        <div className="dash-ops-welcome">
          <h1>Welcome back</h1>
          <p>
            {viewAllStores
              ? `All store operations, ${financeTab === "today" ? "today" : financeTab === "week" ? "last 7 days" : "last 30 days"}`
              : selectedCode
                ? `Store operations, ${financeTab === "today" ? "today" : financeTab === "week" ? "last 7 days" : "last 30 days"}`
                : "Connect a store to see live operations."}
            {refreshing ? " Refreshing…" : ""}
          </p>
        </div>
        <div className="dash-ops-header-actions">
          {stores.length > 0 && (
            <DashboardStoreSelect
              stores={stores}
              value={viewAllStores ? "all" : String(selectedStoreId ?? stores[0]?.storeId ?? "")}
              onChange={next => {
                if (next === "all") {
                  setViewAllStores(true)
                  return
                }
                setViewAllStores(false)
                setSelectedStoreId(Number(next))
              }}
            />
          )}
          <button type="button" onClick={() => void refreshDashboardData()} className="dash-ops-refresh" disabled={refreshing}>
            Refresh
          </button>
        </div>
      </header>

      {oauthBanner && (
        <div
          className="dash-ops-banner"
          style={{
            border: `1px solid ${oauthBanner.type === "success" ? "#1E6B48" : "#6E3036"}`,
            background: oauthBanner.type === "success" ? "#143028" : "#3A1E24",
            color: oauthBanner.type === "success" ? "#3DDC97" : "#F07178",
          }}
        >
          {oauthBanner.text}
        </div>
      )}
      {error && (
        <div className="dash-ops-error">
          <p style={{ margin: "0 0 12px" }}>{error}</p>
          <button type="button" onClick={() => void load()} className="dash-ops-refresh">Retry</button>
        </div>
      )}

      {setupIncomplete ? (
        <>
          <PrimaryCtaCard
            connected={connected}
            hasStore={hasStore}
            hasListings={hasListings}
            pendingAlerts={pendingAlerts}
            connecting={connecting}
            onConnect={() => void handleConnectEbay()}
            ebayStores={(ebayStatus?.stores ?? []).filter(s => s.connected)}
          />
          <OnboardingChecklist steps={checklistSteps} />
        </>
      ) : (
        <details className="dash-ops-setup">
          <summary>Setup / Configuration</summary>
          <div className="dash-ops-setup-body">
            <OnboardingChecklist steps={checklistSteps} />
          </div>
        </details>
      )}

      <div className="dash-ops-kpis">
        <DashboardKpiCard
          label="Active Listings"
          value={ops ? fmtInt(ops.kpis.activeListings) : "—"}
          icon={<KpiBarsIcon />}
        />
        <DashboardKpiCard
          label={financeTab === "today" ? "Orders Today" : `Orders (${financeTab === "week" ? "7 Days" : "30 Days"})`}
          value={ops ? fmtInt(ops.kpis.ordersToday) : "—"}
          icon={<KpiBarsIcon />}
        />
        <DashboardKpiCard
          label={financeTab === "today" ? "Gross Sales Today" : `Gross Sales (${financeTab === "week" ? "7 Days" : "30 Days"})`}
          value={moneyUsd(ops?.kpis.grossSalesToday)}
          icon={<KpiBarsIcon />}
        />
        <DashboardKpiCard
          label={financeTab === "today" ? "Net Profit Today" : `Net Profit (${financeTab === "week" ? "7 Days" : "30 Days"})`}
          value={moneyUsd(ops?.kpis.netProfitToday)}
          icon={<KpiBarsIcon />}
        />
        <DashboardKpiCard
          label={viewAllStores ? "Stores With Issues" : "Needs Attention"}
          value={attentionCount == null ? "—" : fmtInt(attentionCount)}
          tone="warning"
          icon={<KpiWarnIcon />}
          delta={attentionCount != null && attentionCount > 0 ? "Review" : undefined}
          hint={attentionCount != null && attentionCount > 0 ? "open items" : undefined}
        />
      </div>

      <div className="dash-ops-board">
        <DashboardSection
          title="Finance Overview"
          variant="finance"
          action={
            <div className="dash-ops-tabs">
              {(["today", "week", "month"] as const).map(tab => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setFinanceTab(tab)}
                  className={`dash-ops-tab${financeTab === tab ? " dash-ops-tab--active" : ""}`}
                >
                  {tab === "today" ? "Today" : tab === "week" ? "7 Days" : "30 Days"}
                </button>
              ))}
            </div>
          }
        >
          {!finance ? (
            <p className="dash-ops-empty">Finance data unavailable.</p>
          ) : (
            <div className="dash-ops-finance">
              <div className="dash-ops-finance__row">
                <DashboardMetric label="eBay Gross Sales" value={moneyUsd(finance.ebayGrossSales)} hint="Settled and pending" />
                <DashboardMetric label="Remaining Earnings" value={moneyUsd(finance.ebayRemainingEarnings)} hint="After holds" />
                <DashboardMetric
                  label="Amazon Source Cost"
                  value={moneyUsd(finance.amazonCostKnownTotal)}
                  hint="Known source cost"
                />
              </div>
              <div className="dash-ops-finance__row">
                <DashboardMetric
                  label="Net Profit"
                  value={moneyUsd(finance.profitOnKnownCost)}
                  hint="After source cost"
                  valueTone="green"
                />
                <DashboardMetric
                  label="Profit Margin"
                  value={finance.profitMarginPercent == null ? "—" : `${finance.profitMarginPercent}%`}
                  hint="On remaining earnings of known-cost orders"
                  valueTone="green"
                />
                <DashboardMetric
                  label="Cost Completeness"
                  value={completenessPct}
                  hint={missingCosts > 0 ? `${missingCosts} costs missing` : undefined}
                  valueTone="amber"
                />
              </div>
            </div>
          )}
        </DashboardSection>
        <DashboardSection
          title="Needs Attention"
          variant="attn"
          action={
            attentionCount != null ? (
              <span className="dash-ops-header-badge">
                <span className="dash-ops-dot dash-ops-dot--warning" />
                {fmtInt(attentionCount)}
              </span>
            ) : undefined
          }
        >
          <NeedsAttentionList items={ops?.needsAttention ?? []} />
        </DashboardSection>
        <DashboardSection title={`Order Pipeline (${periodLabel})`}>
          <OrderPipelineList
            stages={[
              { label: "New", count: ops?.pipeline.newOrders, tone: "neutral" },
              { label: "Amazon Ordered", count: ops?.pipeline.amazonOrdered, tone: "info" },
              { label: "Shipped", count: ops?.pipeline.shipped, tone: "positive" },
              { label: "Delayed", count: ops?.pipeline.delayed, tone: "warning" },
              { label: "Delivered", count: ops?.pipeline.delivered, tone: "positive" },
              { label: "Action Required", count: ops?.pipeline.actionRequired, tone: "critical" },
            ]}
          />
        </DashboardSection>
        <DashboardSection title={`Customer Service (${periodLabel})`}>
          <CustomerServiceSummary cs={ops?.customerService ?? null} periodLabel={periodLabel} />
        </DashboardSection>
        <DashboardSection title="Listing Health">
          <ListingHealthList health={ops?.listingHealth ?? null} />
        </DashboardSection>
        <DashboardSection title={`Recent Activity (${periodLabel})`}>
          <RecentActivityList items={ops?.recentActivity ?? []} />
        </DashboardSection>
      </div>

      {viewAllStores && ops && (
        <div className="dash-ops-full">
          <DashboardSection title="Store Performance">
            {ops.storeRows.length === 0 ? (
              <p className="dash-ops-empty">No stores in this workspace.</p>
            ) : (
              <DashboardTable
                columns={[
                  "Store",
                  financeTab === "today" ? "Orders Today" : `Orders (${financeTab === "week" ? "7 Days" : "30 Days"})`,
                  "Gross Sales",
                  "Known Source Cost",
                  "Net Profit",
                  "Active Listings",
                  "Alerts / Issues",
                ]}
                rows={ops.storeRows.map(r => [
                  `${r.storeCode} · ${r.storeName}`,
                  String(r.ordersToday),
                  moneyUsd(r.grossSalesToday),
                  `${moneyUsd(r.knownSourceCostToday)} (${r.costKnownCount}/${r.costTotalCount})`,
                  moneyUsd(r.netProfitToday),
                  String(r.activeListings),
                  String(r.alerts),
                ])}
              />
            )}
          </DashboardSection>
        </div>
      )}
    </div>
  )
}

function PrimaryCtaCard({
  connected,
  hasStore,
  hasListings,
  pendingAlerts,
  connecting,
  onConnect,
  ebayStores,
}: {
  connected: boolean
  hasStore: boolean
  hasListings: boolean
  pendingAlerts: number
  connecting: boolean
  onConnect: () => void
  ebayStores: { storeCode: string; name: string; status: string }[]
}) {
  if (!connected || !hasStore) {
    return (
      <div style={{ ...dashCard, marginBottom: 0, borderColor: "#2E4D73" }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px", color: "#F5F7FB" }}>Your next step</h2>
        <p style={{ color: "#A7B3C4", margin: "0 0 16px", lineHeight: 1.5, fontSize: 13 }}>
          Connect your eBay store to unlock settings, listings, and stock monitoring.
        </p>
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          style={{
            ...checklistPrimaryBtnStyle,
            padding: "10px 18px",
            background: connecting ? "#667386" : checklistPrimaryBtnStyle.background,
            cursor: connecting ? "not-allowed" : "pointer",
          }}
        >
          {connecting ? "Connecting…" : "Connect eBay Store"}
        </button>
      </div>
    )
  }
  if (!hasListings) {
    return (
      <div style={{ ...dashCard, marginBottom: 0 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px", color: "#F5F7FB" }}>Import your listings</h2>
        <p style={{ color: "#A7B3C4", margin: "0 0 16px", lineHeight: 1.5, fontSize: 13 }}>
          Your store is connected{ebayStores.length > 0 ? ` (${ebayStores.map(s => s.storeCode).join(", ")})` : ""}.
          Import active eBay listings to start monitoring.
        </p>
        <ChecklistLink href="/app/import">Import Listings</ChecklistLink>
      </div>
    )
  }
  return (
    <div style={{ ...dashCard, marginBottom: 0 }}>
      <h2 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px", color: "#F5F7FB" }}>Keep monitoring</h2>
      <p style={{ color: "#A7B3C4", margin: 0, fontSize: 13 }}>
        {pendingAlerts > 0
          ? `${pendingAlerts} pending stock alert${pendingAlerts === 1 ? "" : "s"} to review.`
          : "Listings are being monitored."}
      </p>
    </div>
  )
}
