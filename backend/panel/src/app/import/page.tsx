"use client"

import { useState } from "react"

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000"

type ImportResponse = {
  totalInput:           number
  valid:                number
  inserted:             number
  skippedDuplicate:     number
  skippedStoreConflict: number
  invalid:              number
  invalidAsins:         string[]
  duplicateAsins:       string[]
  conflictAsins:        string[]
  insertedAsins:        string[]
}

function ResultRow({ label, value, color, detail }: {
  label:   string
  value:   number
  color:   string
  detail?: string[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: "14px", color: "var(--sub)" }}>
          {label}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "18px", fontWeight: 700, color }}>
            {value}
          </span>
          {detail && detail.length > 0 && (
            <button
              onClick={() => setOpen(!open)}
              style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--dim)", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}
            >
              {open ? "▾ hide" : "▸ show"}
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

export default function ImportPage() {
  const [input,    setInput]    = useState("")
  const [loading,  setLoading]  = useState(false)
  const [result,   setResult]   = useState<ImportResponse | null>(null)
  const [error,    setError]    = useState<string | null>(null)

  async function handleImport() {
    const raw = input.trim()
    if (!raw) return

    // Parse: satır, virgül, boşluk ile bölünmüş ASIN'leri dizi yap
    const asins = raw
      .split(/[\n\r,;\s]+/)
      .map(s => s.trim().toUpperCase())
      .filter(s => s.length > 0)

    if (asins.length === 0) return

    setLoading(true); setResult(null); setError(null)

    try {
      const res = await fetch(`${API_BASE}/admin/asins/import`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ asins }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`API ${res.status}: ${text}`)
      }
      const data = await res.json() as ImportResponse
      setResult(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const lineCount = input.split(/[\n\r,;\s]+/).filter(s => s.trim().length > 0).length

  return (
    <div className="max-w-2xl" style={{ animation: "fade-in 0.3s ease forwards" }}>

      {/* Header desc */}
      <p style={{ fontSize: "13px", color: "var(--sub)", marginBottom: "20px", lineHeight: "1.6" }}>
        ASIN'leri satır satır, virgülle veya boşlukla ayrılmış olarak yapıştır.
        Duplicate ve store conflict'ler otomatik filtrelenir.
      </p>

      {/* Textarea */}
      <div style={{ marginBottom: "12px" }}>
        <label htmlFor="asin-input" style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", display: "block", marginBottom: "8px" }}>
          ASIN List
        </label>
        <textarea
          id="asin-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={"B0ABC12345\nB0ABC12346\nB0ABC12347\n\n... veya virgülle ayrılmış"}
          rows={12}
          style={{
            width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: "3px", padding: "12px 14px", color: "var(--text)",
            fontSize: "13px", fontFamily: "'JetBrains Mono', monospace",
            lineHeight: "1.8", resize: "vertical", outline: "none",
          }}
          onFocus={e => { (e.target as HTMLTextAreaElement).style.borderColor = "rgba(0,255,136,0.4)" }}
          onBlur={e  => { (e.target as HTMLTextAreaElement).style.borderColor = "var(--border)" }}
        />
        {lineCount > 0 && (
          <p style={{ fontSize: "11px", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", marginTop: "6px" }}>
            {lineCount} ASIN algılandı
          </p>
        )}
      </div>

      {/* Button */}
      <button
        onClick={handleImport}
        disabled={loading || input.trim().length === 0}
        style={{
          width: "100%", padding: "12px 0", borderRadius: "3px", border: "none",
          cursor: (loading || input.trim().length === 0) ? "not-allowed" : "pointer",
          background: (loading || input.trim().length === 0) ? "var(--muted)" : "var(--accent)",
          color: "#000", fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 700, fontSize: "13px", letterSpacing: "1px", textTransform: "uppercase",
          opacity: (loading || input.trim().length === 0) ? 0.6 : 1,
          transition: "opacity 0.15s",
          marginBottom: "20px",
        }}
      >
        {loading ? "Importing…" : "▶ Import ASINs"}
      </button>

      {/* Error */}
      {error && (
        <div style={{ padding: "12px 16px", background: "rgba(255,68,85,0.06)", border: "1px solid rgba(255,68,85,0.2)", borderRadius: "3px", color: "var(--danger)", fontSize: "13px", fontFamily: "'JetBrains Mono', monospace", marginBottom: "16px" }}>
          ✗ {error}
        </div>
      )}

      {/* Result */}
      {result && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", padding: "20px 24px" }}>
          <p style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", marginBottom: "16px" }}>
            Import Report
          </p>

          <ResultRow label="Total Input"        value={result.totalInput}           color="var(--text)"   />
          <ResultRow label="Valid ASINs"         value={result.valid}                color="var(--sub)"    />
          <ResultRow label="✓ Inserted"          value={result.inserted}             color="var(--accent)" detail={result.insertedAsins} />
          <ResultRow label="— Duplicate Skipped" value={result.skippedDuplicate}     color="var(--dim)"    detail={result.duplicateAsins} />
          <ResultRow label="— Store Conflict"    value={result.skippedStoreConflict} color="var(--warn)"   detail={result.conflictAsins} />
          <ResultRow label="✗ Invalid Format"    value={result.invalid}              color="var(--danger)" detail={result.invalidAsins} />

          {result.inserted > 0 && (
            <div style={{ marginTop: "16px", padding: "10px 14px", background: "rgba(0,255,136,0.05)", border: "1px solid rgba(0,255,136,0.15)", borderRadius: "3px", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace", color: "var(--accent)" }}>
              ✓ {result.inserted} ASIN havuza eklendi — scrape kuyruğuna alındı
            </div>
          )}

          {result.inserted === 0 && result.valid > 0 && (
            <div style={{ marginTop: "16px", padding: "10px 14px", background: "rgba(255,170,0,0.05)", border: "1px solid rgba(255,170,0,0.15)", borderRadius: "3px", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace", color: "var(--warn)" }}>
              — Tüm ASIN'ler zaten sistemde veya mağaza çakışması var
            </div>
          )}
        </div>
      )}
    </div>
  )
}
