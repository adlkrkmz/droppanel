"use client"

import { useEffect, useState } from "react"

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "https://api.listjetgo.com"

const AMAZON_CATEGORIES = [
  { value: "aps",                            label: "All Departments" },
  { value: "electronics",                    label: "Electronics" },
  { value: "kitchen",                        label: "Kitchen & Dining" },
  { value: "toys-and-games",                 label: "Toys & Games" },
  { value: "sporting-goods",                 label: "Sports & Outdoors" },
  { value: "health-personal-care",           label: "Health & Personal Care" },
  { value: "beauty",                         label: "Beauty & Personal Care" },
  { value: "tools",                          label: "Tools & Home Improvement" },
  { value: "home-garden",                    label: "Home & Garden" },
  { value: "pet-supplies",                   label: "Pet Supplies" },
  { value: "office-products",                label: "Office Products" },
  { value: "baby-products",                  label: "Baby" },
  { value: "clothing-accessories-and-shoes", label: "Clothing & Shoes" },
  { value: "automotive",                     label: "Automotive" },
  { value: "grocery",                        label: "Grocery & Gourmet Food" },
]

type Candidate = {
  asin:               string
  title:              string | null
  brand:              string | null
  price:              number | null
  rating:             number | null
  reviewCount:        number | null
  boughtPastMonth:    number | null
  hasPrime:           boolean
  hasFastDelivery:    boolean
  hasLowStockWarning: boolean
  isSponsored:        boolean
  url:                string | null
}

type RejectedItem = {
  candidate: Candidate
  reasons:   string[]
}

type ImportResult = {
  totalInput:           number
  valid:                number
  inserted:             number
  skippedDuplicate:     number
  skippedStoreConflict: number
  invalid:              number
  insertedAsins:        string[]
  duplicateAsins:       string[]
  conflictAsins:        string[]
  invalidAsins:         string[]
}

function fmt(n: number | null) {
  if (n == null) return "—"
  return n.toLocaleString()
}

const mono: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" }
const sans: React.CSSProperties = { fontFamily: "'DM Sans', sans-serif" }

export default function ScanPage() {
  const [extReady,        setExtReady]        = useState(false)

  // ── Filtreler ─────────────────────────────────────────────────────────────
  const [keyword,         setKeyword]         = useState("")
  const [category,        setCategory]        = useState("aps")
  const [pageCount,       setPageCount]       = useState(3)
  const [minPrice,        setMinPrice]        = useState("")
  const [maxPrice,        setMaxPrice]        = useState("")
  const [minRating,       setMinRating]       = useState("")
  const [minReviews,      setMinReviews]      = useState("")
  const [maxReviews,      setMaxReviews]      = useState("")
  const [minSales,        setMinSales]        = useState("")
  const [maxSales,        setMaxSales]        = useState("")
  const [primeReq,        setPrimeReq]        = useState(false)
  const [fastDelivReq,    setFastDelivReq]    = useState(false)
  const [lowStockBlock,   setLowStockBlock]   = useState(true)
  const [noSponsored,     setNoSponsored]     = useState(false)
  const [titleCapsRule,   setTitleCapsRule]   = useState(true)
  const [skipBrandBL,     setSkipBrandBL]     = useState(false)
  const [bannedWords,     setBannedWords]     = useState("")

  // ── Scan state ────────────────────────────────────────────────────────────
  const [scanning,        setScanning]        = useState(false)
  const [progress,        setProgress]        = useState<{ phase: string; page: number; total: number; count: number } | null>(null)
  const [scanError,       setScanError]       = useState<string | null>(null)

  const [passed,          setPassed]          = useState<Candidate[]>([])
  const [rejected,        setRejected]        = useState<RejectedItem[]>([])
  const [skippedBrand,    setSkippedBrand]    = useState(0)
  const [selected,        setSelected]        = useState<Set<string>>(new Set())
  const [showRejected,    setShowRejected]    = useState(false)

  // ── Import state ──────────────────────────────────────────────────────────
  const [importing,       setImporting]       = useState(false)
  const [importResult,    setImportResult]    = useState<ImportResult | null>(null)
  const [importError,     setImportError]     = useState<string | null>(null)

  const allSelected  = passed.length > 0 && selected.size === passed.length
  const someSelected = selected.size > 0

  // ── Extension ready polling ───────────────────────────────────────────────
  useEffect(() => {
    if (extReady) return
    function onReady(e: MessageEvent) {
      if (e.data?.type === "DP_EXTENSION_READY") setExtReady(true)
    }
    window.addEventListener("message", onReady)
    const iv = setInterval(() => window.postMessage({ type: "DP_PING" }, "*"), 600)
    window.postMessage({ type: "DP_PING" }, "*")
    return () => { window.removeEventListener("message", onReady); clearInterval(iv) }
  }, [extReady])

  // ── Scan message listener ─────────────────────────────────────────────────
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data
      if (!d || typeof d.type !== "string") return

      if (d.type === "DP_EXTENSION_READY") { setExtReady(true); return }

      if (d.type === "DP_SCAN_PROGRESS") {
        setProgress({ phase: d.phase, page: d.page, total: d.total, count: d.count })
        return
      }

      if (d.type === "DP_SCAN_DONE") {
        setScanning(false); setProgress(null)
        const p: Candidate[] = d.passed     || []
        const r: RejectedItem[] = d.rejected || []
        setPassed(p)
        setRejected(r)
        setSkippedBrand(d.skippedBrand || 0)
        setSelected(new Set(p.map((c: Candidate) => c.asin)))
        return
      }

      if (d.type === "DP_SCAN_ERROR") {
        setScanning(false); setProgress(null)
        setScanError(d.error || "Bilinmeyen hata")
        return
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [])

  function buildAmazonUrl() {
    const k = encodeURIComponent(keyword.trim())
    const parts = [`https://www.amazon.com/s?k=${k}`]
    if (category && category !== "aps") parts.push(`i=${category}`)
    return parts.join("&")
  }

  function openAmazon() { window.open(buildAmazonUrl(), "_blank") }

  function startScan() {
    if (!keyword.trim()) return
    setScanning(true); setScanError(null); setImportResult(null); setImportError(null)
    setPassed([]); setRejected([]); setSkippedBrand(0); setSelected(new Set())

    const bw = bannedWords.split(/[,\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean)

    window.postMessage({
      type:       "DP_TO_BG_SCAN_START",
      amazonUrl:  buildAmazonUrl(),
      keyword:    keyword.trim(),
      category,
      pageCount,
      filters: {
        minPrice:             minPrice    ? parseFloat(minPrice)    : null,
        maxPrice:             maxPrice    ? parseFloat(maxPrice)    : null,
        minRating:            minRating   ? parseFloat(minRating)   : 0,
        minReviewCount:       minReviews  ? parseInt(minReviews,10) : 0,
        maxReviewCount:       maxReviews  ? parseInt(maxReviews,10) : null,
        minMonthlySales:      minSales    ? parseInt(minSales,10)   : null,
        maxMonthlySales:      maxSales    ? parseInt(maxSales,10)   : null,
        primeRequired:        primeReq,
        fastDeliveryRequired: fastDelivReq,
        lowStockBlocked:      lowStockBlock,
        titleAllCapsRule:     titleCapsRule,
        excludeSponsored:     noSponsored,
        skipBrandBlacklist:   skipBrandBL,
        bannedWords:          bw,
      },
    }, "*")
  }

  function stopScan() {
    window.postMessage({ type: "DP_TO_BG_SCAN_STOP" }, "*")
    setScanning(false); setProgress(null)
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(passed.map(c => c.asin)))
  }

  function toggleRow(asin: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(asin)) next.delete(asin); else next.add(asin)
      return next
    })
  }

  async function handleImport() {
    if (!someSelected) return
    const asins = [...selected]
    setImporting(true); setImportResult(null); setImportError(null)
    try {
      const res = await fetch(`${API_BASE}/admin/asins/import`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ asins }),
      })
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(() => "")}`)
      setImportResult(await res.json() as ImportResult)
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  function phaseLabel(phase: string) {
    if (phase === "opening")   return "Amazon açılıyor…"
    if (phase === "scanning")  return "Sayfa taranıyor…"
    if (phase === "not_ready") return "Sayfa yüklenmedi"
    return phase
  }

  const totalScanned = passed.length + rejected.length

  return (
    <div style={{ animation: "fade-in 0.3s ease forwards" }}>

      {/* Extension uyarısı */}
      {!extReady && (
        <div style={{ marginBottom: "16px", padding: "10px 16px", background: "rgba(255,170,0,0.07)", border: "1px solid rgba(255,170,0,0.25)", borderRadius: "3px", fontSize: "12px", ...mono, color: "var(--warn)" }}>
          ⚠ DropPanel extension hazır değil. Chrome'a yüklüyse sayfayı yenile.
        </div>
      )}

      {/* ─ Filtreler ──────────────────────────────────────────────────────── */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", padding: "20px 24px", marginBottom: "16px" }}>
        <p style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)", ...mono, marginBottom: "16px" }}>
          Arama &amp; Filtreler
        </p>

        {/* Keyword + Category + Pages */}
        <div style={{ display: "flex", gap: "12px", marginBottom: "12px", flexWrap: "wrap" }}>
          <div style={{ flex: "2 1 220px" }}>
            <FLabel>Anahtar Kelime</FLabel>
            <FInput value={keyword} onChange={setKeyword} placeholder="örn: wireless earbuds"
              onKeyDown={e => e.key === "Enter" && !scanning && keyword.trim() && startScan()} />
          </div>
          <div style={{ flex: "1 1 180px" }}>
            <FLabel>Kategori</FLabel>
            <select value={category} onChange={e => setCategory(e.target.value)} style={selectStyle}>
              {AMAZON_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div style={{ flex: "0 0 90px" }}>
            <FLabel>Sayfa</FLabel>
            <FInput type="number" min={1} max={30} value={pageCount}
              onChange={v => setPageCount(Math.max(1, Math.min(30, parseInt(v) || 1)))} />
          </div>
        </div>

        {/* Price / Rating / Reviews / Sales */}
        <div style={{ display: "flex", gap: "12px", marginBottom: "12px", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 90px" }}>
            <FLabel>Min Fiyat ($)</FLabel>
            <FInput type="number" min={0} value={minPrice} onChange={setMinPrice} placeholder="0" />
          </div>
          <div style={{ flex: "1 1 90px" }}>
            <FLabel>Max Fiyat ($)</FLabel>
            <FInput type="number" min={0} value={maxPrice} onChange={setMaxPrice} placeholder="999" />
          </div>
          <div style={{ flex: "1 1 90px" }}>
            <FLabel>Min Rating</FLabel>
            <select value={minRating} onChange={e => setMinRating(e.target.value)} style={selectStyle}>
              <option value="">Hepsi</option>
              {["3.0","3.5","4.0","4.2","4.5"].map(v => <option key={v} value={v}>{v}+</option>)}
            </select>
          </div>
          <div style={{ flex: "1 1 100px" }}>
            <FLabel>Min Yorum</FLabel>
            <FInput type="number" min={0} value={minReviews} onChange={setMinReviews} placeholder="50" />
            <FLabel>Max Yorum</FLabel>
            <FInput type="number" min={0} value={maxReviews} onChange={setMaxReviews} placeholder="10000" />
          </div>
          <div style={{ flex: "1 1 120px" }}>
            <FLabel>Min Aylık Satış</FLabel>
            <FInput type="number" min={0} value={minSales} onChange={setMinSales} placeholder="50" />
            <FLabel>Max Aylık Satış</FLabel>
            <FInput type="number" min={0} value={maxSales} onChange={setMaxSales} placeholder="10000" />
          </div>
        </div>

        {/* Banned words */}
        <div style={{ marginBottom: "12px" }}>
          <FLabel>Yasaklı Kelimeler (başlıkta geçen ürünleri atla)</FLabel>
          <FInput value={bannedWords} onChange={setBannedWords} placeholder="gun, knife, weapon  (virgül veya alt satır ile ayır)" />
        </div>

        {/* Checkboxes */}
        <div style={{ display: "flex", gap: "18px", flexWrap: "wrap", marginBottom: "16px" }}>
          <CBox label="Prime zorunlu"        checked={primeReq}      onChange={setPrimeReq} />
          <CBox label="Fast delivery"        checked={fastDelivReq}  onChange={setFastDelivReq} />
          <CBox label="Low stock engelle"    checked={lowStockBlock} onChange={setLowStockBlock} />
          <CBox label="Sponsorlu hariç"      checked={noSponsored}   onChange={setNoSponsored} />
          <CBox label="ALL CAPS başlık hariç" checked={titleCapsRule} onChange={setTitleCapsRule} />
          <CBox label="Brand blacklist atla" checked={skipBrandBL}   onChange={setSkipBrandBL}
            warn="Brand blacklist ~550 VeRO markayı filtreler. Kapatmak önerilmez." />
        </div>

        {/* Buttons */}
        <div style={{ display: "flex", gap: "10px" }}>
          <button onClick={openAmazon} disabled={!keyword.trim()} style={btnStyle("var(--surface)", "var(--border)", !keyword.trim())}>
            ↗ Amazon&apos;da Aç
          </button>
          {!scanning ? (
            <button onClick={startScan} disabled={!keyword.trim() || !extReady}
              style={btnStyle("var(--accent)", "transparent", !keyword.trim() || !extReady, true)}>
              ▶ Aramayı Başlat
            </button>
          ) : (
            <button onClick={stopScan} style={btnStyle("rgba(255,68,85,0.15)", "rgba(255,68,85,0.35)", false)}>
              ■ Durdur
            </button>
          )}
        </div>
      </div>

      {/* ─ Progress ───────────────────────────────────────────────────────── */}
      {scanning && progress && (
        <div style={{ padding: "10px 16px", marginBottom: "12px", background: "rgba(0,255,136,0.04)", border: "1px solid rgba(0,255,136,0.15)", borderRadius: "3px", display: "flex", alignItems: "center", gap: "16px" }}>
          <span style={{ fontSize: "12px", ...mono, color: "var(--accent)" }}>{phaseLabel(progress.phase)}</span>
          <span style={{ fontSize: "12px", ...mono, color: "var(--sub)" }}>Sayfa {progress.page}/{progress.total}</span>
          <span style={{ fontSize: "12px", ...mono, color: "var(--text)" }}>{progress.count} geçti</span>
          <span style={{ fontSize: "11px", color: "var(--dim)", ...mono }}>●</span>
        </div>
      )}

      {/* ─ Hata ───────────────────────────────────────────────────────────── */}
      {scanError && (
        <div style={{ padding: "12px 16px", marginBottom: "12px", background: "rgba(255,68,85,0.06)", border: "1px solid rgba(255,68,85,0.2)", borderRadius: "3px", fontSize: "13px", ...mono, color: "var(--danger)" }}>
          ✗ {scanError}
        </div>
      )}

      {/* ─ Scan özeti ─────────────────────────────────────────────────────── */}
      {totalScanned > 0 && !scanning && (
        <div style={{ display: "flex", gap: "12px", marginBottom: "12px", flexWrap: "wrap" }}>
          <StatBadge label="Toplam tarandı" value={totalScanned} />
          <StatBadge label="✓ Geçti" value={passed.length} color="var(--accent)" />
          <StatBadge label="✗ Reddedildi" value={rejected.length} color="var(--warn)" />
          <StatBadge label="Brand blacklist" value={skippedBrand} color="var(--dim)" />
        </div>
      )}

      {/* ─ Geçen ASIN'ler ─────────────────────────────────────────────────── */}
      {passed.length > 0 && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", marginBottom: "16px" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ cursor: "pointer", accentColor: "var(--accent)" }} />
              <span style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--accent)", ...mono }}>
                ✓ Geçen — {passed.length} ASIN ({selected.size} seçili)
              </span>
            </div>
            <button
              onClick={handleImport}
              disabled={!someSelected || importing}
              style={btnStyle("var(--accent)", "transparent", !someSelected || importing, true)}
            >
              {importing ? "Ekleniyor…" : `▶ Havuza Ekle (${selected.size})`}
            </button>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["", "ASIN", "Başlık", "Marka", "Fiyat", "Rating", "Yorum", "Aylık Satış", "Prime", "Fast"].map((h, i) => (
                    <Th key={i}>{h}</Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {passed.map((c, i) => {
                  const isSel = selected.has(c.asin)
                  return (
                    <tr key={c.asin} style={{
                      borderBottom: "1px solid var(--border)",
                      background: isSel ? "rgba(0,255,136,0.03)" : i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                    }}>
                      <Td>
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggleRow(c.asin)}
                          style={{ accentColor: "var(--accent)", cursor: "pointer", width: "16px", height: "16px" }}
                        />
                      </Td>
                      <Td mono accent>
                        <a
                          href={c.url ?? `https://www.amazon.com/dp/${c.asin}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "var(--accent)", textDecoration: "none" }}
                        >
                          {c.asin}
                        </a>
                      </Td>
                      <Td wide>{c.title || "—"}</Td>
                      <Td dim>{c.brand || "—"}</Td>
                      <Td mono>{c.price !== null ? `$${c.price.toFixed(2)}` : "—"}</Td>
                      <Td mono accent={!!(c.rating && c.rating >= 4)}>{c.rating !== null ? c.rating.toFixed(1) : "—"}</Td>
                      <Td mono>{fmt(c.reviewCount)}</Td>
                      <Td mono warn={!!(c.boughtPastMonth && c.boughtPastMonth >= 100)}>{c.boughtPastMonth !== null ? fmt(c.boughtPastMonth) + "+/mo" : "—"}</Td>
                      <Td center accent={c.hasPrime}>{c.hasPrime ? "✓" : ""}</Td>
                      <Td center accent={c.hasFastDelivery}>{c.hasFastDelivery ? "✓" : ""}</Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─ Reddedilen ASIN'ler ────────────────────────────────────────────── */}
      {rejected.length > 0 && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", marginBottom: "16px" }}>
          <div
            onClick={() => setShowRejected(!showRejected)}
            style={{ padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between" }}
          >
            <span style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--warn)", ...mono }}>
              ✗ Reddedilen — {rejected.length} ASIN
            </span>
            <span style={{ fontSize: "11px", color: "var(--dim)", ...mono }}>{showRejected ? "▾ gizle" : "▸ göster"}</span>
          </div>
          {showRejected && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["ASIN", "Başlık", "Fiyat", "Rating", "Yorum", "Aylık", "Nedenler"].map((h, i) => (
                      <Th key={i}>{h}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rejected.map((item, i) => {
                    const c = item.candidate
                    return (
                      <tr key={c.asin} style={{ borderBottom: "1px solid var(--border)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)" }}>
                        <Td mono dim>
                          <a
                            href={c.url ?? `https://www.amazon.com/dp/${c.asin}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: "var(--dim)", textDecoration: "none" }}
                          >
                            {c.asin}
                          </a>
                        </Td>
                        <Td wide dim>{c.title || "—"}</Td>
                        <Td mono dim>{c.price !== null ? `$${c.price.toFixed(2)}` : "—"}</Td>
                        <Td mono dim>{c.rating !== null ? c.rating.toFixed(1) : "—"}</Td>
                        <Td mono dim>{fmt(c.reviewCount)}</Td>
                        <Td mono dim>{c.boughtPastMonth !== null ? fmt(c.boughtPastMonth) + "+/mo" : "—"}</Td>
                        <Td>
                          <span style={{ fontSize: "11px", ...mono, color: "var(--warn)" }}>
                            {item.reasons.join(", ")}
                          </span>
                        </Td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ─ Import Result ──────────────────────────────────────────────────── */}
      {importError && (
        <div style={{ padding: "12px 16px", background: "rgba(255,68,85,0.06)", border: "1px solid rgba(255,68,85,0.2)", borderRadius: "3px", color: "var(--danger)", fontSize: "13px", ...mono, marginBottom: "12px" }}>
          ✗ {importError}
        </div>
      )}
      {importResult && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", padding: "20px 24px" }}>
          <p style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)", ...mono, marginBottom: "16px" }}>Import Raporu</p>
          <IRow label="Toplam Gönderildi"     value={importResult.totalInput}           color="var(--text)" />
          <IRow label="✓ Havuza Eklendi"       value={importResult.inserted}             color="var(--accent)" detail={importResult.insertedAsins} />
          <IRow label="— Zaten Havuzda"        value={importResult.skippedDuplicate}     color="var(--dim)"    detail={importResult.duplicateAsins} />
          <IRow label="— Mağaza Çakışması"     value={importResult.skippedStoreConflict} color="var(--warn)"   detail={importResult.conflictAsins} />
          <IRow label="✗ Geçersiz Format"      value={importResult.invalid}              color="var(--danger)" detail={importResult.invalidAsins} />
          {importResult.inserted > 0 && (
            <div style={{ marginTop: "16px", padding: "10px 14px", background: "rgba(0,255,136,0.05)", border: "1px solid rgba(0,255,136,0.15)", borderRadius: "3px", fontSize: "12px", ...mono, color: "var(--accent)" }}>
              ✓ {importResult.inserted} ASIN havuza eklendi — scrape kuyruğuna alındı
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Tiny helper components ────────────────────────────────────────────────────

function FLabel({ children }: { children: React.ReactNode }) {
  return <label style={{ display: "block", fontSize: "11px", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", marginBottom: "6px" }}>{children}</label>
}

function FInput({ value, onChange, placeholder, type, min, max, onKeyDown }: {
  value:       string | number
  onChange:    (v: string) => void
  placeholder?: string
  type?:        string
  min?:         number
  max?:         number
  onKeyDown?:   (e: React.KeyboardEvent<HTMLInputElement>) => void
}) {
  return (
    <input
      type={type || "text"} value={value} placeholder={placeholder} min={min} max={max} onKeyDown={onKeyDown}
      onChange={e => onChange(e.target.value)}
      style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "3px", padding: "8px 10px", color: "var(--text)", fontSize: "13px", fontFamily: "'JetBrains Mono', monospace", outline: "none" }}
      onFocus={e => { e.target.style.borderColor = "rgba(0,255,136,0.4)" }}
      onBlur={e  => { e.target.style.borderColor = "var(--border)" }}
    />
  )
}

function CBox({ label, checked, onChange, warn }: { label: string; checked: boolean; onChange: (v: boolean) => void; warn?: string }) {
  return (
    <label title={warn} style={{ display: "flex", alignItems: "center", gap: "7px", cursor: "pointer", fontSize: "13px", fontFamily: "'DM Sans', sans-serif", color: warn && !checked ? "var(--warn)" : "var(--sub)" }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
      {label}
    </label>
  )
}

function StatBadge({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ padding: "8px 14px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", display: "flex", gap: "10px", alignItems: "baseline" }}>
      <span style={{ fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", color: "var(--dim)", letterSpacing: "0.8px", textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontSize: "18px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: color || "var(--text)" }}>{value}</span>
    </div>
  )
}

const selectStyle: React.CSSProperties = {
  width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "3px",
  padding: "8px 10px", color: "var(--text)", fontSize: "13px", fontFamily: "'JetBrains Mono', monospace", outline: "none",
}

function btnStyle(bg: string, border: string, disabled: boolean, dark = false): React.CSSProperties {
  return {
    padding: "9px 18px", background: disabled ? "var(--muted)" : bg, border: `1px solid ${disabled ? "var(--border)" : border}`,
    borderRadius: "3px", cursor: disabled ? "not-allowed" : "pointer", color: disabled ? "var(--dim)" : dark ? "#000" : "var(--text)",
    fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: "12px", letterSpacing: "0.5px",
    opacity: disabled ? 0.5 : 1, transition: "opacity 0.15s", whiteSpace: "nowrap",
  }
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: "8px 12px", textAlign: "left", fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)", whiteSpace: "nowrap" }}>{children}</th>
}

function Td({ children, mono: isMono, accent, dim, warn: isWarn, center, wide }: {
  children:  React.ReactNode
  mono?:     boolean
  accent?:   boolean
  dim?:      boolean
  warn?:     boolean
  center?:   boolean
  wide?:     boolean
}) {
  return (
    <td style={{
      padding: "8px 12px", fontFamily: isMono ? "'JetBrains Mono', monospace" : "'DM Sans', sans-serif",
      color: accent ? "var(--accent)" : isWarn ? "var(--warn)" : dim ? "var(--dim)" : "var(--text)",
      textAlign: center ? "center" : "left",
      maxWidth: wide ? "260px" : undefined, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: wide ? "nowrap" : undefined,
    }}>
      {children}
    </td>
  )
}

function IRow({ label, value, color, detail }: { label: string; value: number; color: string; detail?: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: "14px", color: "var(--sub)" }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "18px", fontWeight: 700, color }}>{value}</span>
          {detail && detail.length > 0 && (
            <button onClick={() => setOpen(!open)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--dim)", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}>
              {open ? "▾ gizle" : "▸ göster"}
            </button>
          )}
        </div>
      </div>
      {open && detail && (
        <div style={{ marginTop: "8px", padding: "8px 10px", background: "var(--muted)", borderRadius: "3px", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "var(--sub)", lineHeight: "1.8" }}>
          {detail.join("  ·  ")}
        </div>
      )}
    </div>
  )
}
