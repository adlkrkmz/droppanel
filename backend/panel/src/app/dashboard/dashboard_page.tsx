import { getSummary }  from "@/lib/api"
import StatCard         from "@/components/ui/StatCard"

export const dynamic = "force-dynamic"

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="text-xs uppercase tracking-widest mb-3 mt-6 first:mt-0"
      style={{ color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}
    >
      {children}
    </h2>
  )
}

function PipelineBar({ stages }: {
  stages: { validated: number; scraped: number; ai_generated: number; listed: number }
}) {
  const total = stages.validated + stages.scraped + stages.ai_generated + stages.listed || 1
  const items = [
    { key: "validated",    label: "Validated",    color: "var(--info)",   value: stages.validated    },
    { key: "scraped",      label: "Scraped",      color: "var(--warn)",   value: stages.scraped      },
    { key: "ai_generated", label: "AI Generated", color: "var(--accent)", value: stages.ai_generated },
    { key: "listed",       label: "Listed",       color: "#b4ff6a",       value: stages.listed       },
  ]

  return (
    <div
      className="p-4 rounded-sm animate-fade-in"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      <p className="text-xs font-mono uppercase tracking-widest mb-3" style={{ color: "var(--dim)" }}>
        Pipeline Distribution
      </p>
      <div className="flex h-2 rounded-full overflow-hidden mb-4" style={{ background: "var(--muted)" }}>
        {items.map(item => (
          <div
            key={item.key}
            style={{ width: `${(item.value / total) * 100}%`, background: item.color, transition: "width 0.6s ease" }}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {items.map(item => (
          <div key={item.key} className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: item.color }} />
            <div>
              <p className="text-xs" style={{ color: "var(--sub)" }}>{item.label}</p>
              <p className="text-sm font-mono font-semibold" style={{ color: item.color }}>{item.value}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default async function DashboardPage() {
  let data: Awaited<ReturnType<typeof getSummary>> | null = null
  let error: string | null = null

  try {
    data = await getSummary()
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load dashboard"
  }

  if (error) {
    return (
      <div
        className="max-w-xl p-5 rounded-sm text-sm font-mono"
        style={{ background: "rgba(255,68,85,0.06)", border: "1px solid rgba(255,68,85,0.2)", color: "var(--danger)" }}
      >
        <p className="font-bold mb-1">Connection Error</p>
        <p style={{ color: "var(--sub)" }}>{error}</p>
        <p className="mt-3 text-xs" style={{ color: "var(--dim)" }}>
          Make sure backend is running: npx ts-node server.ts
        </p>
      </div>
    )
  }

  if (!data) return null

  const { dashboard, runtime } = data

  return (
    <div className="max-w-5xl animate-fade-in">
      <SectionTitle>Overview</SectionTitle>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="ASIN Registry"  value={dashboard.asinRegistryTotal} accent="blue"    sub="total tracked" />
        <StatCard label="Pool Total"     value={dashboard.asinPoolTotal}     accent="default" sub="all pool entries" />
        <StatCard label="Pool Ready"     value={dashboard.poolReady}         accent="yellow"  sub="awaiting process" />
        <StatCard label="Completed"      value={dashboard.poolCompleted}     accent="green"   sub="listed on eBay" />
      </div>

      <SectionTitle>Pipeline Stages</SectionTitle>
      <PipelineBar stages={dashboard.pipelineStages} />

      <SectionTitle>Stores</SectionTitle>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total Stores"  value={dashboard.storesTotal}  accent="default" />
        <StatCard label="Active Stores" value={dashboard.storesActive} accent="green"   sub="receiving listings" />
      </div>

      <SectionTitle>Runtime</SectionTitle>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Loop Status"   value={runtime.loopStatus}  accent={runtime.loopStatus === "running" ? "green" : "default"} />
        <StatCard label="Turn"          value={runtime.turn}         accent="default" mono />
        <StatCard label="Recent Turns"  value={runtime.recentTurns}  accent="default" mono />
        <StatCard label="Last Turn"     value={runtime.lastTurnAt ? new Date(runtime.lastTurnAt).toLocaleTimeString("en-GB") : "—"} accent="default" mono />
      </div>

      <div
        className="mt-6 px-4 py-3 rounded-sm text-xs font-mono"
        style={{ background: "rgba(0,255,136,0.04)", border: "1px solid rgba(0,255,136,0.12)", color: "var(--dim)" }}
      >
        last updated: {new Date(dashboard.generatedAt).toLocaleString("en-GB")}
      </div>
    </div>
  )
}
