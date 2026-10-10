"use client"

import { useState, useEffect, useMemo } from "react"
import Link from "next/link"
import { getStores, postListingsImportMatch } from "@/lib/api"
import type { StoreRow, ImportMatchResponse, ImportMatchRowResult } from "@/lib/api"
import { useStore } from "@/lib/storeContext"
import { useToast } from "@/lib/toastContext"
import {
  parseImportText,
  validateImportRows,
  buildErrorListCsv,
  buildImportMatchErrorCsv,
  type ImportValidateResult,
} from "@/lib/listingsUtils"

const PLACEHOLDER = `366179912345    B0GWJXKN8K
366337912345    B0FHVJ1234
366592912345    B0989JXXXX`

const mono: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "11px",
}

const btnStyle = (primary?: boolean, disabled?: boolean): React.CSSProperties => ({
  ...mono,
  padding: "8px 16px",
  borderRadius: "3px",
  border: primary ? "none" : "1px solid var(--border)",
  background: primary ? "var(--accent)" : "var(--surface)",
  color: primary ? "#000" : "var(--text)",
  fontWeight: 700,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.55 : 1,
})

const VALIDATE_COLORS: Record<string, string> = {
  "Valid Format": "var(--accent)",
  "Invalid ASIN": "var(--danger)",
  "Missing eBay ID": "var(--danger)",
  "Missing ASIN": "var(--danger)",
  "Duplicate eBay ID": "var(--warn)",
  "Duplicate ASIN": "var(--warn)",
}

const MATCH_COLORS: Record<string, string> = {
  UPDATED: "var(--accent)",
  ALREADY_EXISTS: "var(--info)",
  DUPLICATE_ASIN_WARNING: "var(--warn)",
  EBAY_NOT_FOUND: "var(--danger)",
  INVALID_ASIN: "var(--danger)",
  DUPLICATE_EBAY_ID: "var(--warn)",
  STORE_CONFLICT: "var(--warn)",
  FAILED: "var(--danger)",
}

type DisplayRow = ImportValidateResult | ImportMatchRowResult

function isMatchRow(r: DisplayRow): r is ImportMatchRowResult {
  return "ebayItemId" in r
}

export default function ImportListingsPage() {
  const { selectedStore, setSelectedStore, isStoreReady } = useStore()
  const { showToast } = useToast()

  const [stores, setStores] = useState<StoreRow[]>([])
  const [text, setText] = useState("")
  const [validateResults, setValidateResults] = useState<ImportValidateResult[] | null>(null)
  const [importResponse, setImportResponse] = useState<ImportMatchResponse | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    void getStores()
      .then(d => setStores(d.rows ?? []))
      .catch(() => setStores([]))
  }, [])

  useEffect(() => {
    const active = stores.filter(s => s.status === "active")
    const list = active.length > 0 ? active : stores
    if (list.length === 0) return
    if (!list.some(s => s.storeCode === selectedStore)) {
      setSelectedStore(list[0].storeCode)
    }
  }, [stores, selectedStore, setSelectedStore])

  const storeOptions = useMemo(() => {
    const active = stores.filter(s => s.status === "active")
    return active.length > 0 ? active : stores
  }, [stores])

  const validRowCount = useMemo(() => {
    if (!validateResults) return 0
    return validateResults.filter(r => r.status === "Valid Format").length
  }, [validateResults])

  const canImport =
    Boolean(selectedStore) &&
    validateResults !== null &&
    validRowCount > 0 &&
    !importing

  function handleValidate() {
    if (!selectedStore) {
      showToast("Select a store first", "error")
      return
    }
    const rows = parseImportText(text)
    if (rows.length === 0) {
      showToast("Paste at least one row", "error")
      setValidateResults(null)
      setImportResponse(null)
      return
    }
    const validated = validateImportRows(rows)
    setValidateResults(validated)
    setImportResponse(null)
    const valid = validated.filter(r => r.status === "Valid Format").length
    showToast(`Validated ${rows.length} row(s) — ${valid} valid format`, "success")
  }

  async function handleImportMatch() {
    if (!canImport || !validateResults) return

    const rows = validateResults
      .filter(r => r.status === "Valid Format")
      .map(r => ({ ebayItemId: r.ebayId, asin: r.asin }))

    if (rows.length === 0) {
      showToast("No valid rows to import", "error")
      return
    }

    setImporting(true)
    try {
      const res = await postListingsImportMatch(selectedStore, rows)
      setImportResponse(res)
      showToast(
        `Import complete — ${res.summary.updated} updated, ${res.summary.alreadyExists} already matched`,
        res.summary.failed > 0 ? "error" : "success"
      )
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Import failed", "error")
    } finally {
      setImporting(false)
    }
  }

  function handleDownloadErrors() {
    if (importResponse?.results?.length) {
      const csv = buildImportMatchErrorCsv(importResponse.results)
      if (csv.split("\n").length <= 1) {
        showToast("No import errors to download", "error")
        return
      }
      downloadCsv(csv, `import-match-errors-${selectedStore}-${Date.now()}.csv`)
      showToast("Error list downloaded", "success")
      return
    }

    if (!validateResults?.length) {
      showToast("Run Validate or Import first", "error")
      return
    }
    const csv = buildErrorListCsv(validateResults)
    if (csv.split("\n").length <= 1) {
      showToast("No validation errors to download", "error")
      return
    }
    downloadCsv(csv, `import-validate-errors-${selectedStore}-${Date.now()}.csv`)
    showToast("Error list downloaded", "success")
  }

  function downloadCsv(content: string, filename: string) {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const displayRows: DisplayRow[] | null = importResponse?.results ?? validateResults
  const summary = importResponse?.summary

  return (
    <div style={{ maxWidth: 960, animation: "fade-in 0.3s ease forwards" }}>
      <div
        style={{
          marginBottom: 16,
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          alignItems: "center",
        }}
      >
        <label style={{ ...mono, color: "var(--dim)" }}>Store</label>
        <select
          aria-label="Import store"
          value={selectedStore}
          onChange={e => {
            setSelectedStore(e.target.value)
            setImportResponse(null)
          }}
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "3px",
            padding: "7px 10px",
            color: "var(--accent)",
            fontWeight: 600,
            ...mono,
          }}
        >
          {storeOptions.map(s => (
            <option key={s.storeCode} value={s.storeCode}>
              {s.name?.trim() || s.storeCode}
            </option>
          ))}
        </select>
      </div>

      <textarea
        value={text}
        onChange={e => {
          setText(e.target.value)
          setImportResponse(null)
        }}
        placeholder={PLACEHOLDER}
        rows={12}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "14px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "4px",
          color: "var(--text)",
          ...mono,
          lineHeight: 1.6,
          resize: "vertical",
          marginBottom: 12,
        }}
      />

      <p style={{ ...mono, color: "var(--dim)", fontSize: 10, marginBottom: 16 }}>
        Format: eBay ID + ASIN — tab, comma, semicolon, or space separated. One pair per line.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 24 }}>
        <button type="button" onClick={handleValidate} style={btnStyle(true)}>
          Validate
        </button>
        <button
          type="button"
          onClick={() => void handleImportMatch()}
          disabled={!canImport}
          style={btnStyle(true, !canImport)}
        >
          {importing ? "Importing…" : "Import & Match"}
        </button>
        <button type="button" onClick={handleDownloadErrors} style={btnStyle()}>
          Download Error List
        </button>
      </div>

      {summary && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))",
            gap: 10,
            marginBottom: 16,
            padding: "12px 14px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            ...mono,
            fontSize: 10,
          }}
        >
          {[
            ["Total", summary.total],
            ["Updated", summary.updated],
            ["Already exists", summary.alreadyExists],
            ["Not found", summary.ebayNotFound],
            ["Conflict", summary.storeConflict],
            ["Invalid", summary.invalidAsin],
            ["Failed", summary.failed],
          ].map(([label, val]) => (
            <div key={String(label)}>
              <span style={{ color: "var(--dim)" }}>{label}: </span>
              <span style={{ color: "var(--text)", fontWeight: 700 }}>{val}</span>
            </div>
          ))}
        </div>
      )}

      {importResponse && summary && (summary.updated > 0 || summary.alreadyExists > 0) && (
        <Link
          href="/listings/my-listings"
          style={{
            display: "inline-block",
            marginBottom: 16,
            ...mono,
            padding: "8px 14px",
            background: "rgba(0,255,136,0.1)",
            border: "1px solid rgba(0,255,136,0.35)",
            borderRadius: "3px",
            color: "var(--accent)",
            textDecoration: "none",
            fontWeight: 700,
          }}
        >
          Go to My Listings →
        </Link>
      )}

      {displayRows && displayRows.length > 0 && (
        <div
          style={{
            overflowX: "auto",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            background: "var(--surface)",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
            <thead>
              <tr>
                {["Row", "eBay ID", "ASIN", "Status", "Message"].map(h => (
                  <th
                    key={h}
                    style={{
                      ...mono,
                      padding: "8px 10px",
                      textAlign: "left",
                      color: "var(--dim)",
                      borderBottom: "1px solid var(--border)",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      fontSize: 10,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map(r => {
                const ebayId = isMatchRow(r) ? r.ebayItemId : r.ebayId
                const colors = importResponse ? MATCH_COLORS : VALIDATE_COLORS
                return (
                  <tr key={`${r.row}-${ebayId}-${r.asin}`}>
                    <td style={{ ...mono, padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
                      {r.row}
                    </td>
                    <td style={{ ...mono, padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
                      {ebayId || "—"}
                    </td>
                    <td style={{ ...mono, padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
                      {r.asin || "—"}
                    </td>
                    <td
                      style={{
                        ...mono,
                        padding: "8px 10px",
                        borderBottom: "1px solid var(--border)",
                        color: colors[r.status] ?? "var(--text)",
                        fontWeight: 600,
                      }}
                    >
                      {r.status}
                    </td>
                    <td
                      style={{
                        ...mono,
                        padding: "8px 10px",
                        borderBottom: "1px solid var(--border)",
                        color: "var(--sub)",
                      }}
                    >
                      {r.message}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
