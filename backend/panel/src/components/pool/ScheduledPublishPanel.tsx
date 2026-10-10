"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  cancelScheduledPublishCommand,
  createScheduledPublishCommand,
  fetchScheduledPublishCommand,
  fetchScheduledPublishCommands,
  fetchScheduledPublishJobs,
  pauseScheduledPublishCommand,
  resumeScheduledPublishCommand,
  runScheduledPublishLiveOne,
} from "@/lib/api"
import type {
  ScheduleExecutionMode,
  ScheduleJobProgress,
  SchedulePublishResponse,
  ScheduleSelectionMode,
  ScheduleSkipDetail,
  ScheduledLiveRunnerRunResponse,
  ScheduledPublishCommand,
  ScheduledPublishJob,
  StoreRow,
  TitleMode,
} from "@/lib/api"

const INTERVAL_PRESETS: { label: string; seconds: number | "custom" }[] = [
  { label: "30 seconds", seconds: 30 },
  { label: "1 minute", seconds: 60 },
  { label: "2 minutes", seconds: 120 },
  { label: "3 minutes", seconds: 180 },
  { label: "5 minutes", seconds: 300 },
  { label: "10 minutes", seconds: 600 },
  { label: "Custom seconds", seconds: "custom" },
]

const SCHEDULE_SKIP_LABELS: Record<string, string> = {
  POOL_ITEM_ARCHIVED:        "Archived",
  POOL_ITEM_ALREADY_LISTED:  "Already listed",
  POOL_ITEM_COMPLETED:       "Completed",
  POOL_ITEM_SUCCESS:         "Already published",
  POOL_ITEM_NOT_FOUND:       "Pool item could not be resolved. Job creation bug or item removed.",
  POOL_ITEM_MISSING_OR_DELETED: "Pool row missing (possible legacy physical delete).",
  POOL_ITEM_ARCHIVED_NOT_ELIGIBLE: "Archived — not eligible for publish.",
  NOT_PRIME:                 "Ürün Prime değil. Listeleme durduruldu.",
  OUT_OF_STOCK:              "Out of stock on Amazon.",
  LIMITED_STOCK:             "Amazon’da sınırlı stok tespit edildi. Ürün listelenmedi.",
  NO_VALID_PRICE:            "No valid Amazon price.",
  NEEDS_AMAZON_VALIDATION:   "Prime/stock check required — run extension extract.",
  PRIME_UNKNOWN:             "Prime doğrulanamadı. Yalnızca seçili Amazon teklifinde açık Prime kanıtı bulunan ürünler listelenebilir.",
  STOCK_UNKNOWN:             "Stok durumu doğrulanamadı. Ürün listelenmedi.",
  POOL_ITEM_NOT_ELIGIBLE:    "Not eligible",
  STORE_CONFLICT:            "Store conflict",
  NOT_READY:                 "Not ready",
  POOL_ITEM_ALREADY_QUEUED:  "Already queued",
  MY_LISTINGS_DUPLICATE:     "Already in My Listings",
}

const COMMAND_STATUS_COLORS: Record<string, string> = {
  scheduled: "var(--info)",
  running:   "var(--info)",
  simulated: "var(--accent)",
  published: "var(--accent)",
  paused:    "var(--warn)",
  completed: "var(--accent)",
  failed:    "var(--danger)",
  cancelled: "var(--sub)",
}

const mono: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" }
const inputStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "3px",
  padding: "8px 10px",
  color: "var(--text)",
  fontSize: 11,
  ...mono,
  width: "100%",
}

function defaultStartLocal(): string {
  const d = new Date(Date.now() + 10 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtDt(iso: string | null | undefined): string {
  if (!iso) return "—"
  return iso.slice(0, 16).replace("T", " ")
}

function skipLabel(reason: string): string {
  return SCHEDULE_SKIP_LABELS[reason] ?? reason
}

function progressText(p?: ScheduleJobProgress): string {
  if (!p) return "—"
  const done = p.published + p.failed + p.cancelled + p.skipped
  return `${p.published} listed · ${p.failed} failed · ${p.skipped} skipped · ${done}/${p.total}`
}

const SHOW_LIVE_RUNNER_UI = false

function StatusBadge({ status }: { status: string }) {
  const color = COMMAND_STATUS_COLORS[status] ?? "var(--dim)"
  const label = status === "published" ? "listed" : status
  return (
    <span style={{ padding: "1px 7px", borderRadius: "20px", fontSize: "10px", fontWeight: 700, ...mono, textTransform: "uppercase", background: color + "22", color }}>
      {label}
    </span>
  )
}

function SkipBanner({ details, title }: { details: ScheduleSkipDetail[]; title?: string }) {
  if (details.length === 0) return null
  const shown = details.slice(0, 5)
  const more = details.length - shown.length
  return (
    <div style={{ padding: "10px 12px", marginTop: 10, background: "rgba(255,193,7,0.06)", border: "1px solid rgba(255,193,7,0.25)", borderRadius: "3px", fontSize: 11, ...mono, color: "var(--warn)" }}>
      <p style={{ fontWeight: 700, marginBottom: 6 }}>{title ?? `${details.length} ASINs were skipped.`}</p>
      {shown.map((d) => (
        <div key={`${d.poolId ?? "x"}-${d.reason}`} style={{ color: "var(--sub)", marginBottom: 2 }}>
          {d.asin ?? `Pool #${d.poolId ?? "?"}`}
          {d.poolId != null ? ` · #${d.poolId}` : ""} · {skipLabel(d.reason)}
        </div>
      ))}
      {more > 0 && <div style={{ color: "var(--dim)", marginTop: 4 }}>+{more} more skipped</div>}
    </div>
  )
}

type Props = {
  stores: StoreRow[]
  scheduleStoreCode: string
  onScheduleStoreChange: (code: string) => void
  selectedPoolIds: Set<number>
  titleMode: TitleMode
}

export default function ScheduledPublishPanel({
  stores,
  scheduleStoreCode,
  onScheduleStoreChange,
  selectedPoolIds,
  titleMode,
}: Props) {
  const [selectionMode, setSelectionMode] = useState<ScheduleSelectionMode>("ready_next")
  const [count, setCount] = useState(40)
  const [startLocal, setStartLocal] = useState(defaultStartLocal)
  const [intervalPreset, setIntervalPreset] = useState<number | "custom">(180)
  const [customInterval, setCustomInterval] = useState(180)
  const [quantity, setQuantity] = useState(1)
  const executionMode: ScheduleExecutionMode = "live"
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createResult, setCreateResult] = useState<SchedulePublishResponse | null>(null)

  const [commands, setCommands] = useState<ScheduledPublishCommand[]>([])
  const [cmdPage, setCmdPage] = useState(1)
  const [cmdTotal, setCmdTotal] = useState(0)
  const [cmdLoading, setCmdLoading] = useState(false)
  const [cmdError, setCmdError] = useState<string | null>(null)

  const [expandedCommandId, setExpandedCommandId] = useState<number | null>(null)
  const [detailCommand, setDetailCommand] = useState<ScheduledPublishCommand | null>(null)
  const [detailSkipDetails, setDetailSkipDetails] = useState<ScheduleSkipDetail[] | undefined>()
  const [jobs, setJobs] = useState<ScheduledPublishJob[]>([])
  const [jobsPage, setJobsPage] = useState(1)
  const [jobsTotal, setJobsTotal] = useState(0)
  const [jobsStatusFilter, setJobsStatusFilter] = useState("all")
  const [jobsLoading, setJobsLoading] = useState(false)
  const [actionLoadingId, setActionLoadingId] = useState<number | null>(null)

  const [liveRunnerStoreFilter, setLiveRunnerStoreFilter] = useState("")
  const [liveRunnerCommandId, setLiveRunnerCommandId] = useState("")
  const [liveRunnerConfirmChecked, setLiveRunnerConfirmChecked] = useState(false)
  const [liveRunnerLoading, setLiveRunnerLoading] = useState(false)
  const [liveRunnerResult, setLiveRunnerResult] = useState<ScheduledLiveRunnerRunResponse | null>(null)
  const [liveRunnerError, setLiveRunnerError] = useState<string | null>(null)

  const intervalSeconds = intervalPreset === "custom" ? customInterval : intervalPreset
  const scheduleCountMax = 20

  const selectedIds = useMemo(() => [...selectedPoolIds], [selectedPoolIds])

  const canCreate = useMemo(() => {
    if (!scheduleStoreCode.trim()) return false
    if (count < 1 || count > scheduleCountMax) return false
    if (quantity < 1 || quantity > 10) return false
    if (intervalSeconds < 30 || intervalSeconds > 86400) return false
    const start = new Date(startLocal)
    if (Number.isNaN(start.getTime())) return false
    if (selectionMode === "selected") {
      if (selectedIds.length === 0 || selectedIds.length > scheduleCountMax) return false
    }
    return true
  }, [scheduleStoreCode, count, scheduleCountMax, quantity, intervalSeconds, startLocal, selectionMode, selectedIds.length])

  const loadCommands = useCallback(async () => {
    setCmdLoading(true)
    setCmdError(null)
    try {
      const res = await fetchScheduledPublishCommands({
        page: cmdPage,
        limit: 50,
      })
      setCommands(res.commands)
      setCmdTotal(res.total)
    } catch (e) {
      setCmdError(e instanceof Error ? e.message : String(e))
    } finally {
      setCmdLoading(false)
    }
  }, [cmdPage])

  const loadJobs = useCallback(async (commandId: number, page: number, status: string) => {
    setJobsLoading(true)
    try {
      const res = await fetchScheduledPublishJobs(commandId, {
        status: status === "all" ? undefined : status,
        page,
        limit: 100,
      })
      setDetailCommand(res.command)
      setJobs(res.jobs)
      setJobsTotal(res.total)
      setJobsPage(res.page)
    } catch (e) {
      setCmdError(e instanceof Error ? e.message : String(e))
    } finally {
      setJobsLoading(false)
    }
  }, [])

  const openCommandDetail = useCallback(async (commandId: number) => {
    setExpandedCommandId(commandId)
    setJobsStatusFilter("all")
    setJobsPage(1)
    try {
      const detail = await fetchScheduledPublishCommand(commandId)
      setDetailCommand(detail.command)
      setDetailSkipDetails(detail.skipDetails)
      await loadJobs(commandId, 1, "all")
    } catch (e) {
      setCmdError(e instanceof Error ? e.message : String(e))
    }
  }, [loadJobs])

  useEffect(() => { void loadCommands() }, [loadCommands])

  const hasActiveCommands = useMemo(
    () => commands.some(c => c.status === "scheduled" || c.status === "running" || c.status === "paused"),
    [commands]
  )

  useEffect(() => {
    if (!hasActiveCommands) return
    const id = setInterval(() => {
      void loadCommands()
      if (expandedCommandId != null) {
        void loadJobs(expandedCommandId, jobsPage, jobsStatusFilter)
      }
    }, 15_000)
    return () => clearInterval(id)
  }, [hasActiveCommands, loadCommands, expandedCommandId, jobsPage, jobsStatusFilter, loadJobs])

  useEffect(() => {
    if (expandedCommandId == null) return
    void loadJobs(expandedCommandId, jobsPage, jobsStatusFilter)
  }, [expandedCommandId, jobsPage, jobsStatusFilter, loadJobs])

  const handleCreate = async () => {
    if (!canCreate) return
    setCreating(true)
    setCreateError(null)
    setCreateResult(null)
    try {
      const payload = {
        storeCode: scheduleStoreCode.trim(),
        selectionMode,
        count: selectionMode === "selected" ? selectedIds.length : count,
        poolIds: selectionMode === "selected" ? selectedIds : undefined,
        startAt: new Date(startLocal).toISOString(),
        intervalSeconds,
        quantity,
        titleMode,
        executionMode,
        confirm: true,
        evidenceGate: true,
        title: "Scheduled Publish",
      }
      const res = await createScheduledPublishCommand(payload)
      setCreateResult(res)
      setCmdPage(1)
      await loadCommands()
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  const runAction = async (
    commandId: number,
    action: "pause" | "resume" | "cancel",
    confirmMsg: string
  ) => {
    if (!window.confirm(confirmMsg)) return
    setActionLoadingId(commandId)
    setCmdError(null)
    try {
      if (action === "pause") await pauseScheduledPublishCommand(commandId)
      else if (action === "resume") await resumeScheduledPublishCommand(commandId)
      else await cancelScheduledPublishCommand(commandId)
      await loadCommands()
      if (expandedCommandId === commandId) {
        await openCommandDetail(commandId)
      }
    } catch (e) {
      setCmdError(e instanceof Error ? e.message : String(e))
    } finally {
      setActionLoadingId(null)
    }
  }

  const runLiveOne = async () => {
    if (!liveRunnerConfirmChecked) return
    setLiveRunnerLoading(true)
    setLiveRunnerError(null)
    setLiveRunnerResult(null)
    try {
      const commandIdRaw = liveRunnerCommandId.trim()
      const commandId = commandIdRaw ? parseInt(commandIdRaw, 10) : undefined
      const res = await runScheduledPublishLiveOne({
        confirm: true,
        storeCode: liveRunnerStoreFilter.trim() || undefined,
        commandId: commandId && commandId >= 1 ? commandId : undefined,
      })
      setLiveRunnerResult(res)
      await loadCommands()
      if (expandedCommandId != null) {
        await openCommandDetail(expandedCommandId)
      }
    } catch (e) {
      setLiveRunnerError(e instanceof Error ? e.message : String(e))
    } finally {
      setLiveRunnerLoading(false)
    }
  }

  const canRunLiveOne = liveRunnerConfirmChecked && !liveRunnerLoading

  const formatLiveRunnerResultMessage = (res: ScheduledLiveRunnerRunResponse): string | null => {
    const r = res.result
    if (!r?.message) return null
    if (r.message === "MISSING_AMAZON_PRODUCT_CACHE") {
      return "Amazon product data could not be prepared automatically."
    }
    return r.message
  }

  const cmdTotalPages = Math.max(1, Math.ceil(cmdTotal / 50))
  const jobsTotalPages = Math.max(1, Math.ceil(jobsTotal / 100))

  return (
    <div style={{ marginTop: 28, marginBottom: 28 }}>
      {/* Schedule form */}
      <div style={{ padding: 14, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 3, marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)", ...mono, marginBottom: 6 }}>
          Scheduled Publish Queue
        </div>
        <p style={{ fontSize: 11, ...mono, color: "var(--sub)", marginBottom: 12, lineHeight: 1.5 }}>
          Plan timed listings from eligible pool ASINs. Jobs run automatically at the scheduled start time and interval.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, marginBottom: 12 }}>
          <div>
            <label style={{ display: "block", fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", ...mono, marginBottom: 4 }}>Store</label>
            <select value={scheduleStoreCode} onChange={(e) => onScheduleStoreChange(e.target.value)} style={inputStyle}>
              {stores.map((s) => (
                <option key={s.id} value={s.storeCode}>{s.name?.trim() || s.storeCode}</option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", ...mono, marginBottom: 4 }}>Selection Mode</label>
            <select value={selectionMode} onChange={(e) => setSelectionMode(e.target.value as ScheduleSelectionMode)} style={inputStyle}>
              <option value="ready_next">Ready Next</option>
              <option value="selected">Selected ASINs</option>
            </select>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", ...mono, marginBottom: 4 }}>
              {selectionMode === "selected" ? `Selected (${selectedIds.length})` : "Count"}
            </label>
            <input
              type="number"
              min={1}
              max={scheduleCountMax}
              value={selectionMode === "selected" ? selectedIds.length : count}
              disabled={selectionMode === "selected"}
              onChange={(e) => setCount(Math.min(scheduleCountMax, Math.max(1, parseInt(e.target.value) || 1)))}
              style={{ ...inputStyle, opacity: selectionMode === "selected" ? 0.7 : 1 }}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", ...mono, marginBottom: 4 }}>Start</label>
            <input type="datetime-local" value={startLocal} onChange={(e) => setStartLocal(e.target.value)} style={inputStyle} />
          </div>

          <div>
            <label style={{ display: "block", fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", ...mono, marginBottom: 4 }}>Interval</label>
            <select
              value={intervalPreset === "custom" ? "custom" : String(intervalPreset)}
              onChange={(e) => {
                const v = e.target.value
                if (v === "custom") setIntervalPreset("custom")
                else setIntervalPreset(parseInt(v, 10))
              }}
              style={inputStyle}
            >
              {INTERVAL_PRESETS.map((p) => (
                <option key={p.label} value={p.seconds === "custom" ? "custom" : String(p.seconds)}>{p.label}</option>
              ))}
            </select>
          </div>

          {intervalPreset === "custom" && (
            <div>
              <label style={{ display: "block", fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", ...mono, marginBottom: 4 }}>Custom (s)</label>
              <input type="number" min={30} max={86400} value={customInterval} onChange={(e) => setCustomInterval(Math.max(30, parseInt(e.target.value) || 30))} style={inputStyle} />
            </div>
          )}

          <div>
            <label style={{ display: "block", fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", ...mono, marginBottom: 4 }}>Quantity</label>
            <input type="number" min={1} max={10} value={quantity} onChange={(e) => setQuantity(Math.min(10, Math.max(1, parseInt(e.target.value) || 1)))} style={inputStyle} />
          </div>

        </div>

        <p style={{ fontSize: 10, ...mono, color: "var(--dim)", marginBottom: 12 }}>
          Max {scheduleCountMax} items per schedule · Title mode: {titleMode}
        </p>

        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={!canCreate || creating}
          style={{
            padding: "10px 16px",
            borderRadius: 3,
            border: "1px solid rgba(0,170,255,0.3)",
            background: canCreate ? "rgba(0,170,255,0.12)" : "var(--surface)",
            color: canCreate ? "var(--info)" : "var(--dim)",
            fontSize: 11,
            fontWeight: 900,
            ...mono,
            cursor: !canCreate || creating ? "not-allowed" : "pointer",
            opacity: creating ? 0.7 : 1,
          }}
        >
          {creating ? "Creating…" : "Create Schedule"}
        </button>

        {createError && (
          <p style={{ marginTop: 10, fontSize: 11, ...mono, color: "var(--danger)" }}>{createError}</p>
        )}

        {createResult && (
          <div style={{ marginTop: 12, padding: 12, background: "rgba(0,255,136,0.06)", border: "1px solid rgba(0,255,136,0.2)", borderRadius: 3, fontSize: 11, ...mono, color: "var(--accent)" }}>
            <p style={{ fontWeight: 700, marginBottom: 6 }}>Schedule created.</p>
            {createResult.evidenceGate && (
              <p>
                {createResult.evidenceGate.readyForPublishCount > 0
                  ? `${createResult.evidenceGate.readyForPublishCount} ürün yayın kuyruğuna alındı. `
                  : ""}
                {createResult.evidenceGate.captureRequiredCount > 0
                  ? `${createResult.evidenceGate.captureRequiredCount} ürün Amazon kontrol kuyruğuna alındı — Extension otomatik veri toplayacak. `
                  : ""}
                Yayın saati geldiğinde DB&apos;deki ürün bilgileriyle listeleme yapılacak.
              </p>
            )}
            {createResult.command && (
              <>
                <p>Jobs: {createResult.command.createdJobCount} · Eligible: {createResult.command.eligibleCount} · Skipped: {createResult.command.skippedCount}</p>
                <p>Start: {fmtDt(createResult.command.startAt)} · Interval: {createResult.command.intervalSeconds}s · Title mode: {createResult.command.titleMode}</p>
              </>
            )}
            {createResult.skipDetails && createResult.skipDetails.length > 0 && (
              <SkipBanner details={createResult.skipDetails} />
            )}
          </div>
        )}
      </div>

      {/* Commands list */}
      <div style={{ padding: 14, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 3 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)", ...mono }}>
            Scheduled Commands
          </div>
          <button type="button" onClick={() => void loadCommands()} style={{ padding: "5px 12px", border: "1px solid var(--border)", borderRadius: 3, background: "var(--surface)", color: "var(--sub)", fontSize: 11, ...mono, cursor: "pointer" }}>
            ↻ Refresh
          </button>
        </div>

        {cmdError && <p style={{ fontSize: 11, ...mono, color: "var(--danger)", marginBottom: 10 }}>{cmdError}</p>}

        {cmdLoading ? (
          <p style={{ fontSize: 12, ...mono, color: "var(--dim)" }}>Loading…</p>
        ) : commands.length === 0 ? (
          <p style={{ fontSize: 12, ...mono, color: "var(--dim)" }}>No scheduled commands.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, ...mono }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--dim)", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: "6px 8px" }}>ID</th>
                  <th style={{ padding: "6px 8px" }}>Store</th>
                  <th style={{ padding: "6px 8px" }}>Status</th>
                  <th style={{ padding: "6px 8px" }}>Count</th>
                  <th style={{ padding: "6px 8px" }}>Start</th>
                  <th style={{ padding: "6px 8px" }}>Interval</th>
                  <th style={{ padding: "6px 8px" }}>Title Mode</th>
                  <th style={{ padding: "6px 8px" }}>Progress</th>
                  <th style={{ padding: "6px 8px" }}>Jobs</th>
                </tr>
              </thead>
              <tbody>
                {commands.map((cmd) => (
                  <tr key={cmd.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px" }}>{cmd.id}</td>
                    <td style={{ padding: "8px" }}>{cmd.storeCode}</td>
                    <td style={{ padding: "8px" }}><StatusBadge status={cmd.status} /></td>
                    <td style={{ padding: "8px" }}>{cmd.createdJobCount}</td>
                    <td style={{ padding: "8px" }}>{fmtDt(cmd.startAt)}</td>
                    <td style={{ padding: "8px" }}>{cmd.intervalSeconds}s</td>
                    <td style={{ padding: "8px" }}>{cmd.titleMode}</td>
                    <td style={{ padding: "8px", fontSize: 10, color: "var(--sub)" }}>{progressText(cmd.progress)}</td>
                    <td style={{ padding: "8px" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        <button type="button" onClick={() => void openCommandDetail(cmd.id)} style={{ padding: "4px 8px", fontSize: 10, ...mono, cursor: "pointer", border: "1px solid var(--border)", borderRadius: 3, background: expandedCommandId === cmd.id ? "rgba(0,170,255,0.1)" : "transparent", color: "var(--info)" }}>
                          Jobs
                        </button>
                        {(cmd.status === "scheduled" || cmd.status === "running") && (
                          <button type="button" disabled={actionLoadingId === cmd.id} onClick={() => void runAction(cmd.id, "pause", "Pause this schedule?")} style={{ padding: "2px 6px", fontSize: 10, ...mono, cursor: "pointer", border: "1px solid var(--border)", borderRadius: 3, color: "var(--warn)" }}>Pause</button>
                        )}
                        {cmd.status === "paused" && (
                          <button type="button" disabled={actionLoadingId === cmd.id} onClick={() => void runAction(cmd.id, "resume", "Resume this schedule?")} style={{ padding: "2px 6px", fontSize: 10, ...mono, cursor: "pointer", border: "1px solid var(--border)", borderRadius: 3, color: "var(--accent)" }}>Resume</button>
                        )}
                        {cmd.status !== "cancelled" && cmd.status !== "completed" && (
                          <button type="button" disabled={actionLoadingId === cmd.id} onClick={() => void runAction(cmd.id, "cancel", "Cancel this schedule? Pending jobs will be cancelled.")} style={{ padding: "2px 6px", fontSize: 10, ...mono, cursor: "pointer", border: "1px solid var(--border)", borderRadius: 3, color: "var(--danger)" }}>Cancel</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {cmdTotalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, fontSize: 11, ...mono, color: "var(--dim)" }}>
            <button type="button" disabled={cmdPage <= 1} onClick={() => setCmdPage((p) => p - 1)} style={{ padding: "4px 10px", border: "1px solid var(--border)", borderRadius: 3, background: "var(--surface)", cursor: cmdPage <= 1 ? "not-allowed" : "pointer" }}>← Prev</button>
            <span>Page {cmdPage} / {cmdTotalPages} ({cmdTotal} total)</span>
            <button type="button" disabled={cmdPage >= cmdTotalPages} onClick={() => setCmdPage((p) => p + 1)} style={{ padding: "4px 10px", border: "1px solid var(--border)", borderRadius: 3, background: "var(--surface)", cursor: cmdPage >= cmdTotalPages ? "not-allowed" : "pointer" }}>Next →</button>
          </div>
        )}

        {/* Jobs detail panel */}
        {expandedCommandId != null && detailCommand && (
          <div style={{ marginTop: 16, padding: 12, border: "1px solid var(--border)", borderRadius: 3, background: "rgba(0,0,0,0.15)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div>
                <p style={{ fontSize: 12, fontWeight: 700, ...mono, color: "var(--text)" }}>
                  Command #{detailCommand.id} · {detailCommand.storeCode} · <StatusBadge status={detailCommand.status} />
                </p>
                <p style={{ fontSize: 10, ...mono, color: "var(--dim)", marginTop: 4 }}>
                  Start {fmtDt(detailCommand.startAt)} · every {detailCommand.intervalSeconds}s · qty {detailCommand.quantity} · {detailCommand.titleMode}
                </p>
                <p style={{ fontSize: 10, ...mono, color: "var(--dim)", marginTop: 2 }}>Progress: {progressText(detailCommand.progress)}</p>
              </div>
              <button type="button" onClick={() => setExpandedCommandId(null)} style={{ padding: "4px 8px", fontSize: 10, ...mono, border: "1px solid var(--border)", borderRadius: 3, background: "transparent", color: "var(--sub)", cursor: "pointer" }}>Close</button>
            </div>

            {detailSkipDetails && detailSkipDetails.length > 0 && (
              <SkipBanner details={detailSkipDetails} title="Skip details from create" />
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, marginTop: 10 }}>
              <span style={{ fontSize: 10, ...mono, color: "var(--dim)" }}>Filter:</span>
              <select value={jobsStatusFilter} onChange={(e) => { setJobsStatusFilter(e.target.value); setJobsPage(1) }} style={{ ...inputStyle, width: "auto" }}>
                {["all", "scheduled", "running", "published", "failed", "cancelled", "skipped"].map((s) => (
                  <option key={s} value={s}>{s === "published" ? "listed" : s}</option>
                ))}
              </select>
            </div>

            {jobsLoading ? (
              <p style={{ fontSize: 11, ...mono, color: "var(--dim)" }}>Loading jobs…</p>
            ) : jobs.length === 0 ? (
              <p style={{ fontSize: 11, ...mono, color: "var(--dim)" }}>No jobs.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, ...mono }}>
                  <thead>
                    <tr style={{ color: "var(--dim)", borderBottom: "1px solid var(--border)" }}>
                      <th style={{ padding: "4px 6px", textAlign: "left" }}>Pool</th>
                      <th style={{ padding: "4px 6px", textAlign: "left" }}>ASIN</th>
                      <th style={{ padding: "4px 6px", textAlign: "left" }}>Scheduled</th>
                      <th style={{ padding: "4px 6px", textAlign: "left" }}>Status</th>
                      <th style={{ padding: "4px 6px", textAlign: "left" }}>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((j) => {
                      const errKey = j.errorMessage?.trim() ?? ""
                      const errLabel = errKey ? (SCHEDULE_SKIP_LABELS[errKey] ?? errKey) : "—"
                      const errIsValidation = ["NOT_PRIME", "OUT_OF_STOCK", "LIMITED_STOCK", "NO_VALID_PRICE", "NEEDS_AMAZON_VALIDATION", "PRIME_UNKNOWN", "STOCK_UNKNOWN"].includes(errKey)
                      const errIsPrimeOrPool = errIsValidation || ["POOL_ITEM_NOT_FOUND", "POOL_ITEM_MISSING_OR_DELETED", "POOL_ITEM_ARCHIVED_NOT_ELIGIBLE"].includes(errKey)
                      return (
                      <tr key={j.id} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "6px", color: "var(--dim)" }}>#{j.poolId}</td>
                        <td style={{ padding: "6px" }}>
                          {j.asin ? (
                            <a href={`https://www.amazon.com/dp/${j.asin}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--info)", textDecoration: "none" }}>
                              {j.asin}
                            </a>
                          ) : "—"}
                        </td>
                        <td style={{ padding: "6px" }}>{fmtDt(j.scheduledAt)}</td>
                        <td style={{ padding: "6px" }}><StatusBadge status={j.status} /></td>
                        <td style={{ padding: "6px", color: errIsValidation ? "var(--warn)" : "var(--danger)", fontWeight: errIsPrimeOrPool ? 700 : 400, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={errLabel}>{errLabel}</td>
                      </tr>
                    )})}
                  </tbody>
                </table>
              </div>
            )}

            {jobsTotalPages > 1 && (
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 10, ...mono, color: "var(--dim)" }}>
                <button type="button" disabled={jobsPage <= 1} onClick={() => setJobsPage((p) => p - 1)} style={{ padding: "3px 8px", border: "1px solid var(--border)", borderRadius: 3, background: "var(--surface)", cursor: jobsPage <= 1 ? "not-allowed" : "pointer" }}>← Prev</button>
                <span>Page {jobsPage} / {jobsTotalPages}</span>
                <button type="button" disabled={jobsPage >= jobsTotalPages} onClick={() => setJobsPage((p) => p + 1)} style={{ padding: "3px 8px", border: "1px solid var(--border)", borderRadius: 3, background: "var(--surface)", cursor: jobsPage >= jobsTotalPages ? "not-allowed" : "pointer" }}>Next →</button>
              </div>
            )}
          </div>
        )}
      </div>

      {SHOW_LIVE_RUNNER_UI && (
      <div style={{ marginTop: 20, padding: 14, background: "var(--surface)", border: "1px solid rgba(255,80,80,0.35)", borderRadius: 3 }}>
        <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--danger)", ...mono, marginBottom: 6 }}>
          Live Runner — Manual Single Job
        </div>
        <p style={{ fontSize: 11, ...mono, color: "var(--sub)", marginBottom: 6, lineHeight: 1.5 }}>
          Bu işlem eBay&apos;de zamanı gelmiş 1 ürünü canlı yayınlar. Otomatik çalışmaz. Live auto runner kapalı.
        </p>
        <p style={{ fontSize: 10, ...mono, color: "var(--warn)", marginBottom: 10, padding: "8px 10px", background: "rgba(255,80,80,0.06)", border: "1px solid rgba(255,80,80,0.2)", borderRadius: 3 }}>
          Live mode can publish to eBay. Live runner processes only one due job per click. Use count 1 and titlebot for safest tests.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", marginBottom: 12 }}>
          <div>
            <label style={{ display: "block", fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", ...mono, marginBottom: 4 }}>Store filter</label>
            <select value={liveRunnerStoreFilter} onChange={(e) => setLiveRunnerStoreFilter(e.target.value)} style={{ ...inputStyle, width: "auto", minWidth: 140 }}>
              <option value="">All stores</option>
              {stores.map((s) => (
                <option key={s.id} value={s.storeCode}>{s.storeCode}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: "block", fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", ...mono, marginBottom: 4 }}>Command ID (optional)</label>
            <input
              type="number"
              min={1}
              placeholder={expandedCommandId != null ? String(expandedCommandId) : "Any"}
              value={liveRunnerCommandId}
              onChange={(e) => setLiveRunnerCommandId(e.target.value)}
              style={{ ...inputStyle, width: 120 }}
            />
          </div>
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 10, ...mono, color: "var(--warn)", marginBottom: 12, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={liveRunnerConfirmChecked}
            onChange={(e) => setLiveRunnerConfirmChecked(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          Bu işlem eBay&apos;de zamanı gelmiş 1 ürünü canlı yayınlar.
        </label>

        <button
          type="button"
          onClick={() => void runLiveOne()}
          disabled={!canRunLiveOne}
          style={{
            padding: "10px 16px",
            borderRadius: 3,
            border: "1px solid rgba(255,80,80,0.4)",
            background: canRunLiveOne ? "rgba(255,80,80,0.12)" : "var(--surface)",
            color: canRunLiveOne ? "var(--danger)" : "var(--dim)",
            fontSize: 11,
            fontWeight: 900,
            ...mono,
            cursor: !canRunLiveOne ? "not-allowed" : "pointer",
            opacity: liveRunnerLoading ? 0.7 : 1,
          }}
        >
          {liveRunnerLoading ? "Yayınlanıyor…" : "1 Canlı İşi Çalıştır"}
        </button>

        {liveRunnerError && (
          <p style={{ fontSize: 11, ...mono, color: "var(--danger)", marginTop: 10 }}>{liveRunnerError}</p>
        )}

        {liveRunnerResult && (
          <div style={{ marginTop: 12, padding: 12, background: "rgba(255,80,80,0.06)", border: "1px solid rgba(255,80,80,0.2)", borderRadius: 3, fontSize: 11, ...mono }}>
            {liveRunnerResult.message && liveRunnerResult.processed === 0 ? (
              <p style={{ color: "var(--sub)" }}>{liveRunnerResult.message}</p>
            ) : (
              <>
                <p style={{ fontWeight: 700, color: "var(--danger)", marginBottom: 6 }}>
                  {liveRunnerResult.published === 1
                    ? `Published ${liveRunnerResult.published}${liveRunnerResult.result?.ebayItemId ? ` · eBay Item ID ${liveRunnerResult.result.ebayItemId}` : ""}`
                    : `Processed ${liveRunnerResult.processed} · published ${liveRunnerResult.published} · skipped ${liveRunnerResult.skipped} · failed ${liveRunnerResult.failed}`}
                </p>
                {liveRunnerResult.result && (
                  <div style={{ fontSize: 10, color: "var(--sub)", lineHeight: 1.6 }}>
                    Job #{liveRunnerResult.result.jobId ?? "—"} · cmd #{liveRunnerResult.result.commandId ?? "—"} · pool #{liveRunnerResult.result.poolId ?? "—"} · {liveRunnerResult.result.asin ?? "—"}
                    {liveRunnerResult.result.status && <> · <StatusBadge status={liveRunnerResult.result.status} /></>}
                    {liveRunnerResult.result.ebayItemId && liveRunnerResult.published !== 1 && <> · eBay {liveRunnerResult.result.ebayItemId}</>}
                    {formatLiveRunnerResultMessage(liveRunnerResult) && <> · {formatLiveRunnerResultMessage(liveRunnerResult)}</>}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
      )}
    </div>
  )
}
