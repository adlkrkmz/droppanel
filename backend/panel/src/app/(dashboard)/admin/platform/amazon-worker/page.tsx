"use client"

import { useCallback, useEffect, useRef, useState } from "react"

type WorkerCard = {
  slot: string
  role: string
  workerId: string
  status: string
  heartbeatAgeSec: number | null
  lastHeartbeatAt: string | null
  browserRunning: boolean
  currentJobId: number | null
  completed15m: number
  valid15m: number
  ratePerMin15m: number
  completed1h: number
  completed24h: number
  valid24h: number
  incomplete24h: number
  failed24h: number
  matched24h: number
  conflict24h: number
  stale24h: number
  avgDurationSec: number | null
  lastError: string | null
  hostHostname?: string | null
  inactive?: boolean
}

type ActivityRow = {
  at: string | null
  asin: string
  keepaDiff: string
  previous: string
  oxylabs: string
  decision: string
  decisionCode: string | null
  ebay: string
  status: string
  operationKey: string | null
}

type SourceControl = {
  system: string
  systemDetail: string
  keepaCard: string
  keepaHint?: string
  keepa?: { commercialDiffs30m?: number }
  oxylabs?: {
    applyProcessorEnabled?: boolean
    workerOnline?: boolean
    workerStatus?: string | null
    heartbeatAgeSec?: number | null
    workerVersion?: string | null
    lastClaimAt?: string | null
    lastCompletedAt?: string | null
    lastError?: string | null
    pending?: number
    claimed?: number
    completed30m?: number
    completed24h?: number
    failed30m?: number
    failed24h?: number
    expiredClaimed?: number
    oldestPendingAgeSec?: number | null
    httpError24h?: number
    productCalls24h?: number
    duplicateProductCalls?: number
    pricingCalls?: number
    confirmCalls?: number
    productEnabled?: boolean
    pricingEnabled?: boolean
    confirmEnabled?: boolean
    readyNote?: string | null
  }
  apply?: {
    lastAppliedAt?: string | null
    stockZero24h?: number
    priceUpdate24h?: number
    retryable?: number
    failed?: number
    pending?: number
    warning?: boolean
  }
  decisions24h?: Record<string, number>
  stockAlerts24h?: number
  activity?: ActivityRow[]
  oldestWaitingSec?: number | null
  plan?: {
    planMode?: string
    monthlyLimit?: number
    cycleStart?: string | null
    cycleEnd?: string | null
    cycleReserved?: number
    cycleSuccessful?: number
    remaining?: number
    hasPaidCycle?: boolean
  }
}

type Dash = {
  generatedAt: string
  cached?: boolean
  system: string
  systemDetail?: string
  flags: { keepa: boolean; planner: boolean; remoteWorkers: boolean; applyProcessor: boolean; apply: boolean; protocol: boolean }
  health: { api: string; db: string }
  panelHost: {
    ramTotalBytes: number
    ramUsedBytes: number
    ramAvailableBytes: number
    ramUsedPct: number
    swapTotalBytes: number
    swapUsedBytes: number
    cpuPct: number | null
    load1: number | null
    load5: number | null
    load15: number | null
    diskUsedPct: number | null
    chromiumProcessCount: number
    pm2: { api: string; panel: string; publicWorker: string }
  }
  scraperHost: Record<string, unknown>
  workers: WorkerCard[]
  queue: Record<string, unknown>
  capacity: Record<string, unknown>
  activity: Array<{ at: string; worker: string | null; event: string; asinMasked: string; reason: string | null }>
  keepaSensor?: {
    status?: string
    heartbeatAgeSec?: number | null
    collectorVersion?: string
    phase?: string | null
    runMode?: string | null
    keepaApiStatus?: string | null
    tokensLeft?: number | null
    estimatedBucketCapacity?: number | null
    refillRate?: number | null
    refillIn?: number | null
    refillInLabel?: string | null
    scans15m?: number
    scans1h?: number
    scans24h?: number
    dueSold?: number
    dueStandard?: number
    oldestDueAgeSec?: number | null
    queueEtaSec?: number | null
    lastErrorCode?: string | null
    lastKeepaAt?: string | null
    banner?: string
    scanMode?: string | null
    spendableTokens?: number | null
    tokenReserve?: number | null
    observationOutboxPending?: number
    observationOutboxDelivered?: number
    lastKeepaBatchSize?: number | null
    nextDueAt?: string | null
    registryStatusLabel?: string | null
    stallReason?: string | null
  }
  sourceControl?: SourceControl
  oxylabsVerify?: Record<string, unknown>
}

const mono: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }
const display: React.CSSProperties = { fontFamily: "'Syne', sans-serif" }

function tone(v: string): string {
  if (/Kapalı|bilgi|idle/i.test(v) && !/Hatalı|OFFLINE|Çevrimdışı|Durdu/i.test(v)) return "#7dd3fc"
  if (/Hatalı|OFFLINE|Çevrimdışı|Durdu|STALLED|fail/i.test(v)) return "#f87171"
  if (/Uyarı|Token Bekliyor|Beklemede|Cadence|sarı/i.test(v)) return "#eab308"
  if (/Sağlıklı|Çalışıyor|ONLINE|ok|Hazır|Backlog|Senkron/i.test(v)) return "#4ade80"
  return "var(--text)"
}

function fmtNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "Veri yok"
  return new Intl.NumberFormat("tr-TR").format(v)
}

function maybeNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(Number(v))) return "Veri yok"
  return new Intl.NumberFormat("tr-TR").format(Number(v))
}

function fmtAge(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "Veri yok"
  if (sec < 90) return `${Math.round(sec)} sn`
  const min = sec / 60
  if (min < 90) return `${Math.round(min)} dk`
  return `${Math.round(min / 60)} sa`
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "Veri yok"
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return "Veri yok"
  return d.toLocaleString("tr-TR")
}

function Card({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ border: "1px solid var(--border)", background: "var(--surface)", borderRadius: 6, padding: "10px 12px", minWidth: 0 }}>
      <div style={{ ...mono, color: "var(--dim)", fontSize: 9, letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ ...mono, marginTop: 4, fontWeight: 700, fontSize: 13, color: color ?? "var(--text)", wordBreak: "break-word" }}>{value}</div>
      {sub ? <div style={{ ...mono, marginTop: 2, color: "var(--dim)", fontSize: 10 }}>{sub}</div> : null}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--border)", background: "var(--surface)", borderRadius: 6, padding: 12, marginBottom: 12, minWidth: 0 }}>
      <div style={{ ...display, fontWeight: 700, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )
}

function grid(): React.CSSProperties {
  return { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }
}

export default function AmazonScanCenterPage() {
  const [data, setData] = useState<Dash | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)
  const visible = useRef(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/platform/amazon-scan/dashboard", { credentials: "include", cache: "no-store" })
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403 ? "Yetkisiz" : `HTTP ${res.status}`)
        return
      }
      setError(null)
      setData((await res.json()) as Dash)
    } catch (e) {
      setError(e instanceof Error ? e.message : "yüklenemedi")
    }
  }, [])

  useEffect(() => {
    void load()
    const onVis = () => {
      visible.current = document.visibilityState === "visible"
      if (visible.current) void load()
    }
    document.addEventListener("visibilitychange", onVis)
    timer.current = window.setInterval(() => {
      if (visible.current) void load()
    }, 10_000)
    return () => {
      document.removeEventListener("visibilitychange", onVis)
      if (timer.current != null) window.clearInterval(timer.current)
    }
  }, [load])

  const sc = data?.sourceControl
  const k = data?.keepaSensor
  const ox = sc?.oxylabs
  const ap = sc?.apply
  const plan = sc?.plan
  const d24 = sc?.decisions24h ?? {}
  const paid = Boolean(plan?.hasPaidCycle && plan.cycleStart)
  const used = paid ? plan?.cycleSuccessful : null
  const reserved = paid ? plan?.cycleReserved : null
  const remaining = paid ? plan?.remaining : null
  const limit = paid ? plan?.monthlyLimit ?? 98000 : null
  const pct = paid && limit && limit > 0 && reserved != null ? (100 * reserved) / limit : null
  const barColor = pct == null ? "var(--dim)" : pct >= 95 ? "#f87171" : pct >= 80 ? "#eab308" : "#4ade80"
  const eta = k?.queueEtaSec
  const etaLabel = eta == null || !Number.isFinite(eta) || eta < 0 ? "Hesaplanamıyor" : fmtAge(eta)

  return (
    <div style={{ ...mono, width: "100%", maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 14, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ ...display, fontSize: 20, fontWeight: 700, color: "var(--text)", margin: 0 }}>Amazon Kaynak Kontrol Merkezi</h1>
          <p style={{ color: "var(--dim)", marginTop: 4, maxWidth: 720 }}>
            Keepa değişiklikleri izler, Oxylabs Amazon verisini doğrular, mevcut kurallar eBay işlemlerini uygular.
          </p>
        </div>
        <button type="button" onClick={() => void load()} style={{ border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", padding: "6px 12px", borderRadius: 4 }}>
          Şimdi Yenile
        </button>
      </div>
      {error && <p style={{ color: "#f87171", marginBottom: 12 }}>{error}</p>}
      {data && (
        <>
          <div style={{ ...grid(), marginBottom: 12 }}>
            <Card label="Keepa Sensörü" value={sc?.keepaCard ?? "Veri yok"} color={tone(sc?.keepaCard ?? "")} sub={k?.scanMode ?? undefined} />
            <Card
              label="Oxylabs Doğrulama"
              value={ox?.workerOnline ? "ONLINE" : "OFFLINE"}
              color={tone(ox?.workerOnline ? "ONLINE" : "OFFLINE")}
              sub={ox?.readyNote || `heartbeat ${fmtAge(ox?.heartbeatAgeSec ?? null)} · bekleyen ${maybeNum(ox?.pending)}`}
            />
            <Card
              label="eBay Uygulama"
              value={ox?.applyProcessorEnabled ? "Açık" : "Kapalı"}
              color={ap?.warning ? "#eab308" : ox?.applyProcessorEnabled ? "#4ade80" : "#7dd3fc"}
              sub={`son başarılı ${fmtTime(ap?.lastAppliedAt)} · stok0 ${maybeNum(ap?.stockZero24h)} · fiyat ${maybeNum(ap?.priceUpdate24h)}${ap?.warning ? " · RETRYABLE/FAILED" : ""}`}
            />
          </div>

          <Section title="Genel sistem durumu">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: tone(String(sc?.system ?? data.system)) }}>{sc?.systemDetail ?? data.system}</div>
                <div style={{ color: "var(--dim)", marginTop: 4 }}>Keepa · Oxylabs PRIMARY · Apply · API/DB · takılmış iş</div>
              </div>
              <div style={{ color: "var(--dim)" }}>
                {new Date(data.generatedAt).toLocaleTimeString("tr-TR")}
                {data.cached ? " · önbellek 5s" : " · taze"}
              </div>
            </div>
          </Section>

          <Section title="Keepa Değişiklik Sensörü">
            <div style={grid()}>
              <Card label="Collector sürümü" value={k?.collectorVersion ?? "Veri yok"} />
              <Card label="Heartbeat yaşı" value={fmtAge(k?.heartbeatAgeSec ?? null)} />
              <Card label="Tarama modu" value={String(k?.scanMode ?? "Veri yok")} />
              <Card label="Son Keepa sorgusu" value={fmtTime(k?.lastKeepaAt)} />
              <Card label="Son batch boyutu" value={maybeNum(k?.lastKeepaBatchSize)} />
              <Card label="Token mevcut / tavan" value={`${maybeNum(k?.tokensLeft)} / ${maybeNum(k?.estimatedBucketCapacity)}`} />
              <Card label="Korunan token tabanı" value={maybeNum(k?.tokenReserve)} />
              <Card label="Dakikalık refill" value={maybeNum(k?.refillRate)} />
              <Card label="Sonraki refill" value={k?.refillInLabel ?? (k?.refillIn != null ? fmtAge(k.refillIn / 1000) : "Veri yok")} />
              <Card label="Harcanabilir token" value={maybeNum(k?.spendableTokens)} />
              <Card label="Due SOLD" value={maybeNum(k?.dueSold)} />
              <Card label="Due STANDARD" value={maybeNum(k?.dueStandard)} />
              <Card label="En eski gecikme" value={fmtAge(k?.oldestDueAgeSec ?? null)} />
              <Card label="Sonraki due zamanı" value={fmtTime(k?.nextDueAt)} />
              <Card label="Taranan ASIN 15dk / 1s / 24s" value={`${maybeNum(k?.scans15m)} / ${maybeNum(k?.scans1h)} / ${maybeNum(k?.scans24h)}`} />
              <Card label="Son 30dk ticari fark" value={maybeNum(sc?.keepa?.commercialDiffs30m)} />
              <Card label="Observation teslim / bekleyen" value={`${maybeNum(k?.observationOutboxDelivered)} / ${maybeNum(k?.observationOutboxPending)}`} />
              <Card label="Reconcile" value={k?.registryStatusLabel ?? "Veri yok"} />
              <Card label="Son hata" value={k?.lastErrorCode || k?.stallReason || "Yok"} color={k?.lastErrorCode || k?.stallReason ? "#f87171" : undefined} />
            </div>
            <div style={{ marginTop: 10, fontWeight: 700 }}>{k?.banner ?? "—"}</div>
            {sc?.keepaHint ? <div style={{ color: "var(--dim)", marginTop: 4 }}>{sc.keepaHint}</div> : null}
          </Section>

          <Section title="Oxylabs Product Doğrulama">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <span style={{ color: "#4ade80" }}>Product: Açık</span>
              <span style={{ color: "#7dd3fc" }}>Pricing: Kapalı</span>
              <span style={{ color: "#7dd3fc" }}>İkinci doğrulama: Kapalı</span>
            </div>
            <div style={grid()}>
              <Card label="PRIMARY worker" value={ox?.workerOnline ? "ONLINE" : "OFFLINE"} color={tone(ox?.workerOnline ? "ONLINE" : "OFFLINE")} sub={ox?.readyNote ?? undefined} />
              <Card label="Worker sürümü" value={ox?.workerVersion ?? "Veri yok"} />
              <Card label="Heartbeat yaşı" value={fmtAge(ox?.heartbeatAgeSec ?? null)} />
              <Card label="Son claim" value={fmtTime(ox?.lastClaimAt)} />
              <Card label="Son tamamlanan Product" value={fmtTime(ox?.lastCompletedAt)} />
              <Card label="PENDING" value={maybeNum(ox?.pending)} />
              <Card label="CLAIMED" value={maybeNum(ox?.claimed)} />
              <Card label="COMPLETED 30dk / 24s" value={`${maybeNum(ox?.completed30m)} / ${maybeNum(ox?.completed24h)}`} />
              <Card label="FAILED 30dk / 24s" value={`${maybeNum(ox?.failed30m)} / ${maybeNum(ox?.failed24h)}`} />
              <Card label="Lease süresi dolmuş CLAIMED" value={maybeNum(ox?.expiredClaimed)} color={(ox?.expiredClaimed ?? 0) > 0 ? "#eab308" : undefined} />
              <Card label="Son hata" value={ox?.lastError || "Yok"} />
              <Card label="HTTP 401/403/413/429/5xx" value={maybeNum(ox?.httpError24h)} />
              <Card label="Product çağrı sayısı" value={maybeNum(ox?.productCalls24h)} />
              <Card label="Duplicate Product çağrısı" value={maybeNum(ox?.duplicateProductCalls)} />
              <Card label="Pricing çağrısı" value={maybeNum(ox?.pricingCalls)} />
              <Card label="CONFIRM çağrısı" value={maybeNum(ox?.confirmCalls)} />
            </div>
          </Section>

          <Section title="Oxylabs aylık kullanım">
            {paid ? (
              <>
                <div style={grid()}>
                  <Card label="Plan" value="Micro" />
                  <Card label="Dönem başlangıcı" value={fmtTime(plan?.cycleStart)} />
                  <Card label="Dönem bitişi" value={fmtTime(plan?.cycleEnd)} />
                  <Card label="Kullanılan başarılı sonuç" value={fmtNum(used ?? null)} />
                  <Card label="Rezerve edilen" value={fmtNum(reserved ?? null)} />
                  <Card label="Kalan" value={fmtNum(remaining ?? null)} />
                  <Card label="Aylık limit" value="98.000" />
                  <Card label="Yüzdelik kullanım" value={pct == null ? "Veri yok" : `%${pct.toFixed(1)}`} color={barColor} />
                </div>
                <div style={{ marginTop: 10, height: 10, borderRadius: 99, background: "var(--border)", overflow: "hidden" }}>
                  <div style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%`, height: "100%", background: barColor }} />
                </div>
              </>
            ) : (
              <div style={{ color: "var(--dim)" }}>Veri yok</div>
            )}
          </Section>

          <Section title="Son 24 saat karar özeti">
            <div style={grid()}>
              <Card label="ASIN yönlendirmesi" value={maybeNum(d24.sourceAsinMismatch)} sub="SOURCE_ASIN_MISMATCH" />
              <Card label="Stok tükendi" value={maybeNum(d24.outOfStock)} sub="OUT_OF_STOCK" />
              <Card label="Prime uygun değil" value={maybeNum(d24.notPrime)} sub="NOT_PRIME" />
              <Card label="Amazon gönderimi değil" value={maybeNum(d24.notFba)} sub="NOT_FBA" />
              <Card label="Fiyat yükseldi" value={maybeNum(d24.priceChange)} sub="PRICE_CHANGE" />
              <Card label="Fiyat eşleşti" value={maybeNum(d24.priceMatch)} sub="PRICE_MATCH" />
              <Card label="Belirsiz sonuç" value={maybeNum(d24.inconclusive)} sub="PRODUCT_INCONCLUSIVE" />
              <Card label="Stok sıfırlanan" value={maybeNum(d24.stockZero)} />
              <Card label="Fiyatı güncellenen" value={maybeNum(d24.priceUpdated)} />
              <Card label="İşlem gerektirmeyen" value={maybeNum(d24.noAction)} />
              <Card label="Başarısız işlem" value={maybeNum(d24.failed)} />
              <Card label="Stock Alerts" value={maybeNum(sc?.stockAlerts24h)} />
            </div>
          </Section>

          <Section title="Canlı işlem akışı">
            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: 920 }}>
                <div style={{ display: "grid", gridTemplateColumns: "88px 110px 1.2fr 1fr 1fr 1.1fr 1.1fr 1.2fr", gap: 8, color: "var(--dim)", paddingBottom: 6 }}>
                  <span>Zaman</span>
                  <span>ASIN</span>
                  <span>Keepa farkı</span>
                  <span>Önceki bilgi</span>
                  <span>Oxylabs</span>
                  <span>Karar</span>
                  <span>eBay işlemi</span>
                  <span>Durum</span>
                </div>
                {(sc?.activity ?? []).length === 0 ? (
                  <div style={{ color: "var(--dim)", padding: "8px 0" }}>Kayıt yok</div>
                ) : (
                  (sc?.activity ?? []).slice(0, 50).map((ev, i) => (
                    <div key={ev.operationKey || `${ev.at}-${ev.asin}-${i}`} style={{ display: "grid", gridTemplateColumns: "88px 110px 1.2fr 1fr 1fr 1.1fr 1.1fr 1.2fr", gap: 8, padding: "6px 0", borderTop: "1px solid var(--border)" }}>
                      <span>{ev.at ? new Date(ev.at).toLocaleTimeString("tr-TR") : "—"}</span>
                      <span>{ev.asin}</span>
                      <span>{ev.keepaDiff}</span>
                      <span>{ev.previous}</span>
                      <span>{ev.oxylabs}</span>
                      <span title={ev.decisionCode ?? ""}>{ev.decision}</span>
                      <span>{ev.ebay}</span>
                      <span>{ev.status}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </Section>

          <Section title="Kuyruk ve kapasite">
            <div style={grid()}>
              <Card label="Keepa due SOLD / STANDARD" value={`${maybeNum(k?.dueSold)} / ${maybeNum(k?.dueStandard)}`} />
              <Card label="Oxylabs PENDING / CLAIMED" value={`${maybeNum(ox?.pending)} / ${maybeNum(ox?.claimed)}`} />
              <Card label="Apply PENDING / RETRYABLE / FAILED" value={`${maybeNum(ap?.pending)} / ${maybeNum(ap?.retryable)} / ${maybeNum(ap?.failed)}`} />
              <Card label="En eski bekleyen iş" value={fmtAge(sc?.oldestWaitingSec ?? null)} />
              <Card label="Tahmini Keepa backlog" value={etaLabel} />
              <Card label="Aylık Oxylabs kalan" value={paid ? fmtNum(remaining ?? null) : "Veri yok"} />
            </div>
          </Section>

          <details style={{ marginTop: 8, color: "var(--dim)" }}>
            <summary style={{ cursor: "pointer", color: "var(--text)" }}>Eski tarayıcı sistemi</summary>
            <div style={{ marginTop: 10 }}>
              <div style={{ ...grid(), marginBottom: 10 }}>
                <Card label="Browser planner" value={data.flags.planner ? "Açık" : "Kapalı"} color="#7dd3fc" />
                <Card label="Remote worker" value={data.flags.remoteWorkers ? "Açık" : "Kapalı"} color="#7dd3fc" />
                <Card label="Chromium (referans)" value={String(data.panelHost?.chromiumProcessCount ?? "—")} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
                {(data.workers ?? []).map(w => (
                  <div key={w.workerId} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
                    <div>Worker {w.slot} · {w.role} · {w.status}</div>
                    <div>heartbeat {w.heartbeatAgeSec ?? "—"}s</div>
                  </div>
                ))}
              </div>
            </div>
          </details>
        </>
      )}
    </div>
  )
}
