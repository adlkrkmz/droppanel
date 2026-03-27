type BadgeProps = {
  value:   string
  variant?: "success" | "error" | "warn" | "info" | "neutral"
}

const VARIANTS = {
  success: { bg: "rgba(0,255,136,0.1)",   color: "var(--accent)",  label: "success" },
  error:   { bg: "rgba(255,68,85,0.1)",   color: "var(--danger)",  label: "failed"  },
  warn:    { bg: "rgba(255,170,0,0.1)",   color: "var(--warn)",    label: "warn"    },
  info:    { bg: "rgba(51,153,255,0.1)",  color: "var(--info)",    label: "info"    },
  neutral: { bg: "rgba(136,136,136,0.1)", color: "var(--sub)",     label: ""        },
}

export default function Badge({ value, variant }: BadgeProps) {
  const v = variant ?? (
    value === "active"   || value === "success" ? "success" :
    value === "inactive" || value === "failed"  ? "error"   :
    value === "pending"                          ? "warn"    :
    "neutral"
  )
  const style = VARIANTS[v]

  return (
    <span
      className="inline-block px-2 py-0.5 rounded-sm text-xs font-mono font-medium uppercase tracking-wider"
      style={{ background: style.bg, color: style.color }}
    >
      {value}
    </span>
  )
}
