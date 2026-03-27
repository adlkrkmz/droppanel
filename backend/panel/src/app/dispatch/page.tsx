"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { getActiveRuns, getRunStatus, getStores, postListingRun } from "@/lib/api"
import type { ListingRunResponse, ListingRunPublishItem } from "@/lib/api"
import { useStore } from "@/lib/storeContext"
import { useToast } from "@/lib/toastContext"

// ─── HELPERS ──────────────────────────────────────────────────

type LogEntry =
  | { type: "info" | "success" | "error" | "warn"; text: string }
  | { type: "sep" }

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>
        {label}
      </label>
      {children}
    </div>
  )
}

const inputSt: React.CSSProperties = {
  background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "3px",
  padding: "8px 10px", color: "var(--text)", fontSize: "13px",
  fontFamily: "'JetBrains Mono', monospace", outline: "none", width: "100%",
}
const selectSt: React.CSSProperties = { ...inputSt, appearance: "none" as const }

function StatusBadge({ status }: { status: ListingRunPublishItem["status"] }) {
  const m = {
    success: { bg: "rgba(0,255,136,0.12)",  color: "var(--accent)" },
    failed:  { bg: "rgba(255,68,85,0.12)",  color: "var(--danger)" },
    blocked: { bg: "rgba(255,170,0,0.12)",  color: "var(--warn)"   },
    skipped: { bg: "rgba(136,136,136,0.1)", color: "var(--sub)"    },
  }
  const s = m[status]
  return (
    <span style={{ ...s, padding: "2px 8px", borderRadius: "20px", fontSize: "10px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase" }}>
      {status}
    </span>
  )
}

function LogBox({ entries }: { entries: LogEntry[] }) {
  return (
    <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "3px", padding: "12px", minHeight: "180px", maxHeight: "300px", overflowY: "auto", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>
      {entries.length === 0
        ? <span style={{ color: "var(--dim)" }}>— ready</span>
        : entries.map((e, i) => {
          if (e.type === "sep") return <div key={i} style={{ borderTop: "1px solid var(--border)", margin: "6px 0" }} />
          const colors = { info: "var(--sub)", success: "var(--accent)", error: "var(--danger)", warn: "var(--warn)" }
          return <div key={i} style={{ color: colors[e.type], lineHeight: "1.8", whiteSpace: "pre-wrap" }}>{e.text}</div>
        })}
    </div>
  )
}

function StatMini({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div style={{ padding: "10px 14px", background: "var(--surface)", border: "1px solid var(--border)", borderTop: `2px solid ${color}`, borderRadius: "3px", textAlign: "center" }}>
      <p style={{ fontSize: "10px", letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>{label}</p>
      <p style={{ fontSize: "20px", fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace", marginTop: "3px" }}>{value}</p>
    </div>
  )
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((completed / total) * 100))) : 0
  return (
    <div style={{ width: "100%", height: 10, background: "rgba(0,0,0,0.06)", border: "1px solid var(--border)", borderRadius: 3, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)" }} />
    </div>
  )
}

function runStatusColor(s: string): string {
  if (s === "completed") return "var(--accent)"
  if (s === "failed") return "var(--danger)"
  if (s === "running") return "var(--warn)"
  if (s === "pending") return "var(--dim)"
  if (s === "cancelled") return "var(--dim)"
  return "var(--dim)"
}

function DispatchJobStatusBadge({ status, failedStage }: { status: string; failedStage?: string | null }) {
  const m: Record<string, { bg: string; color: string }> = {
    pending: { bg: "rgba(136,136,136,0.1)", color: "var(--dim)" },
    claimed: { bg: "rgba(0,170,255,0.10)", color: "var(--warn)" },
    extract_running: { bg: "rgba(0,170,255,0.10)", color: "var(--warn)" },
    ai_running: { bg: "rgba(0,170,255,0.10)", color: "var(--warn)" },
    listing_running: { bg: "rgba(0,170,255,0.10)", color: "var(--warn)" },
    extract_done: { bg: "rgba(0,255,136,0.10)", color: "var(--info)" },
    ai_done: { bg: "rgba(0,255,136,0.10)", color: "var(--info)" },
    listing_done: { bg: "rgba(0,255,136,0.14)", color: "var(--accent)" },
    failed: { bg: "rgba(255,68,85,0.12)", color: "var(--danger)" },
    retry_waiting: { bg: "rgba(0,170,255,0.08)", color: "var(--warn)" },
    cancelled: { bg: "rgba(136,136,136,0.1)", color: "var(--dim)" },
  }

  const item = m[status] ?? { bg: "var(--surface)", color: "var(--dim)" }
  const label = status === "failed" && failedStage ? `failed:${failedStage}` : status
  return (
    <span style={{ padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", background: item.bg, color: item.color }}>
      {label}
    </span>
  )
}

function jobStage(job: any): string {
  if (!job) return "—"
  if (job.status === "failed") return job.failedStage ?? "unknown"
  if (job.status === "retry_waiting") return "retry"
  if (job.status === "claimed") return "claim"
  if (job.status === "pending") return "pending"
  if (job.status === "cancelled") return "cancelled"
  const parts = String(job.status).split("_")
  return parts[0] || "—"
}

// ─── MAIN ─────────────────────────────────────────────────────

export default function DispatchPage() {
  const { selectedStore } = useStore()
  const { showToast } = useToast()
  const [storeErr,  setStoreErr]  = useState<string | null>(null)
  const [count,      setCount]      = useState(10)
  const [mode,       setMode]       = useState<"random"|"priority"|"fifo">("random")
  const [delay,      setDelay]      = useState(5)
  const [quantity,   setQuantity]   = useState(1)
  const [showAdv,    setShowAdv]    = useState(false)
  const [dryRun,     setDryRun]     = useState(true)
  const [simulation, setSimulation] = useState(true)

  const [loading, setLoading] = useState(false)
  const [result,  setResult]  = useState<ListingRunResponse | null>(null)
  const [log,     setLog]     = useState<LogEntry[]>([])

  const [activeRuns, setActiveRuns] = useState<any[]>([])
  const [monitorLoading, setMonitorLoading] = useState(false)
  const [monitorError, setMonitorError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [runStatus, setRunStatus] = useState<any | null>(null)
  const [runStatusLoading, setRunStatusLoading] = useState(false)

  const [legacyOpen, setLegacyOpen] = useState(false)
  const monitorRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    getStores()
      .then(() => setStoreErr(null))
      .catch(e => setStoreErr(e instanceof Error ? e.message : String(e)))
  }, [])

  async function handleRun() {
    setLoading(true); setResult(null)
    setLog([{ type: "info", text: `▶ Starting listing run → ${selectedStore}  count=${count}  mode=${mode}  delay=${delay}s${dryRun ? "  [DRY RUN]" : ""}` }])

    try {
      const res = await postListingRun({ storeCode: selectedStore, count, selectionMode: mode, delaySeconds: delay, quantity, dryRun, simulationMode: simulation })
      setResult(res)
      showToast("Dispatch run completed successfully")

      const dispLog: LogEntry[] = [
        { type: "sep" },
        { type: "success", text: `✓ DISPATCH — selected: ${res.dispatch.selectedCount}  skipped: ${res.dispatch.skippedCount}` },
        ...res.dispatch.assignedAsins.map((a, i): LogEntry => ({ type: "info", text: `   pool=${res.dispatch.assignedPoolIds[i]}  ${a}` })),
        { type: "sep" },
        { type: res.publish.succeeded > 0 ? "success" : "warn",
          text: `✓ PUBLISH — attempted=${res.publish.attempted}  succeeded=${res.publish.succeeded}  blocked=${res.publish.blocked}  failed=${res.publish.failed}` },
        ...res.publish.items.map((item): LogEntry => {
          const icon = item.status === "success" ? "✓" : item.status === "blocked" ? "⊘" : "✗"
          const e = item.guardErrors[0] ? `  [${item.guardErrors[0].slice(0, 55)}]` : ""
          return {
            type: item.status === "success" ? "success" : item.status === "blocked" ? "warn" : "error",
            text: `   ${icon} ${item.asin}  score=${item.guardScore ?? "-"}${e}`,
          }
        }),
        { type: "sep" },
        { type: "info", text: `   total: ${res.totalMs}ms  completed: ${new Date(res.completedAt).toLocaleTimeString("en-GB")}` },
      ]
      setLog(prev => [...prev, ...dispLog])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setLog(prev => [...prev, { type: "error", text: `✗ ${msg}` }])
      showToast(msg, "error")
    } finally { setLoading(false) }
  }

  const loadRunStatusFor = useCallback(async (runId: number): Promise<void> => {
    setRunStatusLoading(true)
    setMonitorError(null)
    try {
      const res = await getRunStatus(runId)
      setRunStatus(res)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setMonitorError(msg)
      setRunStatus(null)
    } finally {
      setRunStatusLoading(false)
    }
  }, [])

  const refreshActiveRuns = useCallback(async (): Promise<void> => {
    setMonitorLoading(true)
    setMonitorError(null)
    try {
      const runs = await getActiveRuns()
      const list = Array.isArray(runs) ? runs : []
      setActiveRuns(list)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setMonitorError(msg)
      setActiveRuns([])
    } finally {
      setMonitorLoading(false)
    }
  }, [])

  const refreshSelectedRun = useCallback(async (): Promise<void> => {
    if (selectedRunId == null) return
    await loadRunStatusFor(selectedRunId)
  }, [loadRunStatusFor, selectedRunId])

  useEffect(() => {
    void refreshActiveRuns()
  }, [refreshActiveRuns])

  useEffect(() => {
    if (!autoRefresh) return
    const id = window.setInterval(() => {
      void refreshActiveRuns()
      void refreshSelectedRun()
    }, 3000)
    return () => window.clearInterval(id)
  }, [autoRefresh, refreshActiveRuns, refreshSelectedRun])

  useEffect(() => {
    if (selectedRunId == null) return
    void loadRunStatusFor(selectedRunId)
  }, [loadRunStatusFor, selectedRunId])

  return (
    <div className="max-w-2xl" style={{ animation: "fade-in 0.3s ease forwards" }}>
      {storeErr && (
        <div style={{ padding: "10px 14px", marginBottom: "16px", background: "rgba(255,68,85,0.06)", border: "1px solid rgba(255,68,85,0.2)", borderRadius: "3px", color: "var(--danger)", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace" }}>
          Backend error: {storeErr}
        </div>
      )}

      <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", color: "var(--sub)", marginBottom: "14px" }}>
        Store: {selectedStore}
      </p>

      {/* BÖLÜM 2: JOB MONITOR */}
      <div style={{ padding: "14px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px" }} ref={monitorRef}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontSize: "12px", fontWeight: 800, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>
            Job Monitor
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              onClick={() => { void refreshActiveRuns(); void refreshSelectedRun() }}
              style={{ background: "transparent", border: "1px solid var(--border)", cursor: "pointer", color: "var(--text)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", padding: "8px 10px", borderRadius: "3px" }}
              disabled={monitorLoading}
            >
              ↻ Refresh
            </button>

            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "12px", color: "var(--sub)", fontFamily: "'JetBrains Mono', monospace" }}>
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} style={{ accentColor: "var(--accent)", width: 14, height: 14 }} />
              Auto-refresh (3s)
            </label>
          </div>
        </div>

        {monitorError && (
          <div style={{ padding: "10px 14px", marginTop: 12, background: "rgba(255,68,85,0.06)", border: "1px solid rgba(255,68,85,0.20)", borderRadius: "3px", color: "var(--danger)", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace" }}>
            {monitorError}
          </div>
        )}

        {/* Active Runs */}
        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
          {activeRuns.length === 0 ? (
            <div style={{ padding: "10px 14px", background: "rgba(0,0,0,0.01)", border: "1px solid var(--border)", borderRadius: "3px", color: "var(--dim)", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace" }}>
              — No active dispatch runs
            </div>
          ) : (
            activeRuns.map((run, idx) => {
              const total = Number(run?.totalJobs ?? 0)
              const completed = Number(run?.completedJobs ?? 0)
              const failed = Number(run?.failedJobs ?? 0)
              const pct = total > 0 ? Math.round((completed / total) * 100) : 0
              const status = String(run?.status ?? "pending")
              const color = runStatusColor(status)
              return (
                <div key={run.id ?? idx} style={{ border: "1px solid var(--border)", borderRadius: "3px", padding: "12px", background: selectedRunId === run.id ? "rgba(255,255,255,0.02)" : "transparent" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "var(--text)", fontWeight: 700 }}>
                        Run #{run.id}
                      </div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "var(--sub)" }}>
                        Store: {run.storeCode}
                      </div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "var(--dim)" }}>
                        created_at: {run.createdAt ? new Date(run.createdAt).toLocaleString("en-GB") : "—"}
                      </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                      <span style={{ background: "rgba(0,0,0,0.02)", border: "1px solid var(--border)", padding: "2px 10px", borderRadius: 20, fontSize: 10, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color, textTransform: "uppercase" }}>
                        {status}
                      </span>
                      {failed > 0 && (
                        <span style={{ color: "var(--danger)", fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                          Failed: {failed}
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <ProgressBar completed={completed} total={total} />
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "var(--dim)" }}>
                      <span>{completed}/{total} ({pct}%)</span>
                      <span>{total > 0 ? "Progress" : "—"}</span>
                    </div>
                  </div>

                  <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
                    <button
                      onClick={() => { setSelectedRunId(run.id); void loadRunStatusFor(run.id) }}
                      disabled={runStatusLoading && selectedRunId === run.id}
                      style={{ background: "var(--bg)", border: "1px solid var(--border)", cursor: "pointer", color: "var(--text)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", padding: "8px 12px", borderRadius: "3px" }}
                    >
                      View Jobs
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Job Details */}
        <div style={{ marginTop: 14, border: "1px solid var(--border)", borderRadius: "3px", overflow: "hidden" }}>
          <div style={{ padding: "10px 12px", background: "var(--surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 800, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)" }}>
              Job Details
            </div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "var(--sub)" }}>
              {selectedRunId == null ? "Select a run to view jobs" : `Run #${selectedRunId}`}
            </div>
          </div>

          {selectedRunId == null ? (
            <div style={{ padding: "14px", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
              — Ready. Select a run above.
            </div>
          ) : (
            <div style={{ padding: "14px" }}>
              {runStatusLoading && (
                <div style={{ padding: "10px 14px", background: "rgba(0,170,255,0.05)", border: "1px solid rgba(0,170,255,0.18)", borderRadius: "3px", color: "var(--sub)", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
                  Loading job details…
                </div>
              )}

              {!runStatusLoading && runStatus && (
                <>
                  {/* Summary stats */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
                    {(() => {
                      const s = runStatus.summary ?? {}
                      const total = Number(s.total ?? 0)
                      const pending = Number(s.pending ?? 0)
                      const running =
                        Number(s.claimed ?? 0) +
                        Number(s.extract_running ?? 0) +
                        Number(s.ai_running ?? 0) +
                        Number(s.listing_running ?? 0)
                      const done =
                        Number(s.extract_done ?? 0) +
                        Number(s.ai_done ?? 0) +
                        Number(s.listing_done ?? 0)
                      const failed = Number(s.failed ?? 0)
                      return (
                        <>
                          <StatMini label="Total" value={total} color="var(--text)" />
                          <StatMini label="Pending" value={pending} color="var(--dim)" />
                          <StatMini label="Running" value={running} color="var(--warn)" />
                          <StatMini label="Done" value={done} color="var(--accent)" />
                          <StatMini label="Failed" value={failed} color="var(--danger)" />
                        </>
                      )
                    })()}
                  </div>

                  {/* Job table */}
                  <div style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: "3px", overflow: "hidden" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 150px 90px 90px 120px 1.4fr 160px", gap: 0, padding: "8px 10px", background: "var(--surface)", borderBottom: "1px solid var(--border)", fontSize: 10, fontWeight: 800, letterSpacing: "1.2px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>
                      <div>ASIN</div>
                      <div>Status</div>
                      <div>Stage</div>
                      <div>Attempt</div>
                      <div>Worker</div>
                      <div>Error</div>
                      <div>Updated</div>
                    </div>

                    <div>
                      {runStatus.jobs.map((job: any, i: number) => (
                        <div
                          key={job.id ?? i}
                          style={{ display: "grid", gridTemplateColumns: "1fr 150px 90px 90px 120px 1.4fr 160px", gap: 0, padding: "8px 10px", fontSize: 12, background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)", borderBottom: i < runStatus.jobs.length - 1 ? "1px solid var(--border)" : "none", fontFamily: "'JetBrains Mono', monospace" }}
                        >
                          <div style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.asin}</div>
                          <div style={{ display: "flex", alignItems: "center" }}>
                            <DispatchJobStatusBadge status={job.status} failedStage={job.failedStage} />
                          </div>
                          <div style={{ color: "var(--sub)" }}>{jobStage(job)}</div>
                          <div style={{ color: "var(--dim)" }}>{job.attemptCount ?? 0}/{job.maxAttempts ?? 0}</div>
                          <div style={{ color: "var(--dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.workerId ?? "—"}</div>
                          <div style={{ color: "var(--dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.lastError ?? "—"}</div>
                          <div style={{ color: "var(--dim)" }}>{job.updatedAt ? new Date(job.updatedAt).toLocaleString("en-GB") : "—"}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {!runStatusLoading && !runStatus && (
                <div style={{ padding: "10px 14px", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                  — No job details available.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ESKİ BÖLÜM: Legacy Listing Run (collapsible) */}
      <div style={{ marginTop: 16 }}>
        <button
          onClick={() => setLegacyOpen(v => !v)}
          style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", padding: "0", letterSpacing: "0.5px" }}
        >
          {legacyOpen ? "▾ Legacy Listing Run" : "▸ Legacy Listing Run"}
        </button>

        {legacyOpen && (
          <div style={{ marginTop: 12 }}>
            {/* Form */}
            <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                <Field id="lr-count" label="Count">
                  <input id="lr-count" type="number" min={1} max={500} value={count}
                    onChange={e => setCount(parseInt(e.target.value) || 1)} style={inputSt} />
                </Field>

                <Field id="lr-mode" label="Selection Mode">
                  <select id="lr-mode" value={mode} onChange={e => setMode(e.target.value as typeof mode)} style={selectSt}>
                    <option value="random">Random</option>
                    <option value="priority">Priority</option>
                    <option value="fifo">FIFO</option>
                  </select>
                </Field>

                <Field id="lr-delay" label="Delay Between Items (s)">
                  <input id="lr-delay" type="number" min={0} max={3600} value={delay}
                    onChange={e => setDelay(parseInt(e.target.value) || 0)} style={inputSt} />
                </Field>

                <Field id="lr-qty" label="Stock Quantity">
                  <input id="lr-qty" type="number" min={1} max={999} value={quantity}
                    onChange={e => setQuantity(parseInt(e.target.value) || 1)} style={inputSt} />
                </Field>
              </div>

              {/* Advanced toggle */}
              <div>
                <button onClick={() => setShowAdv(!showAdv)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", padding: "0", letterSpacing: "0.5px" }}>
                  {showAdv ? "▾" : "▸"} Advanced options
                </button>

                {showAdv && (
                  <div style={{ marginTop: "12px", padding: "14px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", display: "flex", gap: "24px" }}>
                    <label htmlFor="lr-dryrun" style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", color: "var(--sub)" }}>
                      <input id="lr-dryrun" type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} style={{ accentColor: "var(--accent)", width: "14px", height: "14px" }} />
                      <span style={{ color: dryRun ? "var(--warn)" : "var(--sub)" }}>Dry Run</span>
                    </label>
                    <label htmlFor="lr-sim" style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", color: "var(--sub)" }}>
                      <input id="lr-sim" type="checkbox" checked={simulation} onChange={e => setSimulation(e.target.checked)} style={{ accentColor: "var(--accent)", width: "14px", height: "14px" }} />
                      <span style={{ color: simulation ? "var(--info)" : "var(--sub)" }}>Simulation Mode</span>
                    </label>
                  </div>
                )}
              </div>

              {dryRun && (
                <div style={{ padding: "8px 14px", background: "rgba(255,170,0,0.05)", border: "1px solid rgba(255,170,0,0.2)", borderRadius: "3px", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace", color: "var(--warn)" }}>
                  ⚠ Dry Run — guard runs, no eBay calls or DB writes
                </div>
              )}

              {/* Main button */}
              <button
                onClick={handleRun}
                disabled={loading}
                style={{
                  padding: "13px 0", borderRadius: "3px", border: "none",
                  cursor: loading ? "not-allowed" : "pointer",
                  background: loading ? "var(--muted)" : dryRun ? "var(--warn)" : "var(--accent)",
                  color: "#000", fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 700, fontSize: "13px", letterSpacing: "1px", textTransform: "uppercase",
                  opacity: loading ? 0.6 : 1, transition: "opacity 0.15s",
                }}
              >
                {loading ? "Running…" : dryRun ? "▶ Dry Run Listing" : "▶ Start Listing Run"}
              </button>

              {/* Result stats */}
              {result && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "10px" }}>
                  <StatMini label="Dispatched" value={result.dispatch.selectedCount} color="var(--info)" />
                  <StatMini label="Attempted" value={result.publish.attempted} color="var(--text)" />
                  <StatMini label="Succeeded" value={result.publish.succeeded} color="var(--accent)" />
                  <StatMini label="Blocked" value={result.publish.blocked} color="var(--warn)" />
                  <StatMini label="Failed" value={result.publish.failed} color="var(--danger)" />
                </div>
              )}

              {/* Item results table */}
              {result && result.publish.items.length > 0 && (
                <div style={{ border: "1px solid var(--border)", borderRadius: "3px", overflow: "hidden" }}>
                  <div style={{ padding: "7px 12px", background: "var(--surface)", borderBottom: "1px solid var(--border)", fontSize: "10px", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>
                    Publish Results
                  </div>
                  {result.publish.items.map((item, i) => (
                    <div key={item.poolId} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "7px 12px", fontSize: "12px", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)", borderBottom: i < result.publish.items.length - 1 ? "1px solid var(--border)" : "none", fontFamily: "'JetBrains Mono', monospace" }}>
                      <StatusBadge status={item.status} />
                      <span style={{ color: "var(--sub)", flexShrink: 0, fontSize: "11px" }}>pool={item.poolId}</span>
                      <span style={{ color: "var(--text)", flexShrink: 0 }}>{item.asin}</span>
                      <span style={{ color: "var(--dim)", fontSize: "11px" }}>score={item.guardScore ?? "-"}</span>
                      {item.guardErrors[0] && <span style={{ color: "var(--warn)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.guardErrors[0].slice(0, 55)}</span>}
                    </div>
                  ))}
                </div>
              )}

              <Field id="lr-log" label="Log">
                <LogBox entries={log} />
              </Field>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
