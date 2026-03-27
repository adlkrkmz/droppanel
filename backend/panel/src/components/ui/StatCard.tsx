type StatCardProps = {
  label:    string
  value:    string | number
  sub?:     string
  accent?:  "green" | "yellow" | "red" | "blue" | "default"
  mono?:    boolean
}

const ACCENT_COLORS = {
  green:   "var(--accent)",
  yellow:  "var(--warn)",
  red:     "var(--danger)",
  blue:    "var(--info)",
  default: "var(--text)",
}

export default function StatCard({
  label,
  value,
  sub,
  accent = "default",
  mono = true,
}: StatCardProps) {
  const color = ACCENT_COLORS[accent]

  return (
    <div
      className="flex flex-col gap-1 p-4 rounded-sm animate-fade-in"
      style={{
        background:    "var(--surface)",
        border:        "1px solid var(--border)",
        borderTop:     `2px solid ${accent === "default" ? "var(--border)" : color}`,
      }}
    >
      <span
        className="text-xs uppercase tracking-widest"
        style={{ color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}
      >
        {label}
      </span>
      <span
        className="text-3xl font-bold leading-none"
        style={{
          color,
          fontFamily: mono ? "'JetBrains Mono', monospace" : "'Syne', sans-serif",
        }}
      >
        {value}
      </span>
      {sub && (
        <span className="text-xs" style={{ color: "var(--sub)" }}>
          {sub}
        </span>
      )}
    </div>
  )
}
