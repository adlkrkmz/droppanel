"use client"

import type React from "react"

type Column<T> = {
  key:     string
  label:   string
  mono?:   boolean
  render?: (row: T) => React.ReactNode
  width?:  string
}

type DataTableProps<T extends Record<string, unknown>> = {
  columns:   Column<T>[]
  rows:      T[]
  emptyMsg?: string
}

export default function DataTable<T extends Record<string, unknown>>({
  columns,
  rows,
  emptyMsg = "No data",
}: DataTableProps<T>) {
  return (
    <div
      className="w-full overflow-x-auto rounded-sm"
      style={{ border: "1px solid var(--border)" }}
    >
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
            {columns.map(col => (
              <th
                key={col.key}
                className="text-left px-4 py-2.5 text-xs uppercase tracking-widest font-medium"
                style={{
                  color:      "var(--dim)",
                  fontFamily: "'JetBrains Mono', monospace",
                  width:      col.width,
                  whiteSpace: "nowrap",
                }}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="text-center py-10 text-sm"
                style={{ color: "var(--dim)" }}
              >
                {emptyMsg}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={i}
                style={{
                  borderBottom: "1px solid var(--border)",
                  background:   i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = "rgba(0,255,136,0.03)"
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background =
                    i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)"
                }}
              >
                {columns.map(col => (
                  <td
                    key={col.key}
                    className="px-4 py-2.5"
                    style={{
                      color:      "var(--text)",
                      fontFamily: col.mono
                        ? "'JetBrains Mono', monospace"
                        : "'DM Sans', sans-serif",
                      fontSize:   col.mono ? "12px" : "13px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {col.render
                      ? col.render(row)
                      : row[col.key] != null
                        ? String(row[col.key])
                        : <span style={{ color: "var(--dim)" }}>—</span>
                    }
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
