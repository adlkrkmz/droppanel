import { getQueue } from "@/lib/api"
import StatCard      from "@/components/ui/StatCard"

export const dynamic = "force-dynamic"

type QueueBarProps = { label: string; value: number; total: number; color: string }

function QueueBar({ label, value, total, color }: QueueBarProps) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div
      className="p-4 rounded-sm"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      <div className="flex justify-between items-baseline mb-2">
        <span className="text-xs font-mono uppercase tracking-widest" style={{ color: "var(--dim)" }}>
          {label}
        </span>
        <span className="text-xl font-mono font-bold" style={{ color }}>{value}</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--muted)" }}>
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: color }} />
      </div>
      <p className="text-xs mt-1.5 text-right font-mono" style={{ color: "var(--dim)" }}>{pct}% of total</p>
    </div>
  )
}

export default async function QueuePage() {
  let data: Awaited<ReturnType<typeof getQueue>> | null = null
  let error: string | null = null

  try {
    data = await getQueue()
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load queue"
  }

  if (error) {
    return (
      <div
        className="max-w-xl p-5 rounded-sm text-sm font-mono"
        style={{ background: "rgba(255,68,85,0.06)", border: "1px solid rgba(255,68,85,0.2)", color: "var(--danger)" }}
      >
        <p className="font-bold mb-1">Connection Error</p>
        <p style={{ color: "var(--sub)" }}>{error}</p>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="max-w-3xl animate-fade-in">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total Queued" value={data.total}             accent="yellow" sub="all stages" />
        <StatCard label="Scrape"       value={data.scrapeQueueCount}  accent="blue"   />
        <StatCard label="AI Gen"       value={data.aiQueueCount}      accent="green"  />
        <StatCard label="Publish"      value={data.publishQueueCount} accent="yellow" />
      </div>

      <div className="text-xs font-mono uppercase tracking-widest mb-3" style={{ color: "var(--dim)" }}>
        Queue Breakdown
      </div>

      <div className="flex flex-col gap-3">
        <QueueBar label="Scrape Queue"        value={data.scrapeQueueCount}  total={data.total} color="var(--info)"   />
        <QueueBar label="AI Generation Queue" value={data.aiQueueCount}      total={data.total} color="var(--accent)" />
        <QueueBar label="Publish Queue"       value={data.publishQueueCount} total={data.total} color="var(--warn)"  />
      </div>

      <div
        className="mt-6 px-4 py-3 rounded-sm text-xs font-mono"
        style={{ background: "rgba(255,170,0,0.04)", border: "1px solid rgba(255,170,0,0.12)", color: "var(--dim)" }}
      >
        last updated: {new Date(data.generatedAt).toLocaleString("en-GB")}
      </div>
    </div>
  )
}
