import Link from "next/link"
import type { CSSProperties, ReactNode } from "react"

export type ChecklistStepState = "completed" | "pending" | "coming-soon"

export type ChecklistStep = {
  id: string
  title: string
  description: string
  state: ChecklistStepState
  statusLabel: string
  action?: ReactNode
  isNext?: boolean
}

type OnboardingChecklistProps = {
  steps: ChecklistStep[]
}

export function OnboardingChecklist({ steps }: OnboardingChecklistProps) {
  return (
    <div style={cardStyle}>
      <h2 style={{ fontFamily: "'Syne', sans-serif", fontSize: 20, margin: "0 0 8px" }}>
        Start selling smarter on eBay
      </h2>
      <p style={{ color: "var(--dim)", margin: "0 0 20px", fontSize: 14, lineHeight: 1.5 }}>
        Connect your store, import listings, link Amazon ASINs, then review price and stock risks.
      </p>
      <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        {steps.map((step, index) => (
          <li
            key={step.id}
            style={{
              ...stepRowStyle,
              borderColor: step.isNext ? "var(--accent, #3b82f6)" : "var(--border)",
              background: step.isNext ? "rgba(59, 130, 246, 0.06)" : "var(--bg, transparent)",
            }}
          >
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span style={stepNumberStyle}>{index + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{step.title}</span>
                  <StepBadge state={step.state} label={step.statusLabel} />
                  {step.isNext && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: "var(--accent, #3b82f6)",
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                      }}
                    >
                      Next step
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: 13, color: "var(--dim)", lineHeight: 1.45 }}>{step.description}</p>
                {step.action && <div style={{ marginTop: 10 }}>{step.action}</div>}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function StepBadge({ state, label }: { state: ChecklistStepState; label: string }) {
  const colors: Record<ChecklistStepState, { bg: string; color: string }> = {
    completed:   { bg: "rgba(60,180,120,0.15)", color: "#6c9" },
    pending:     { bg: "rgba(234, 179, 8, 0.12)", color: "#eab308" },
    "coming-soon": { bg: "rgba(148, 163, 184, 0.15)", color: "var(--dim)" },
  }
  const c = colors[state]

  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 4,
        background: c.bg,
        color: c.color,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  )
}

export const checklistLinkStyle: CSSProperties = {
  display: "inline-block",
  padding: "6px 14px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  color: "inherit",
  textDecoration: "none",
  fontSize: 13,
}

export const checklistPrimaryBtnStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 6,
  border: "none",
  background: "var(--accent, #3b82f6)",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
  fontSize: 13,
}

export const checklistDisabledStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 14px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  fontSize: 13,
  color: "var(--dim)",
  opacity: 0.75,
  cursor: "not-allowed",
}

export function ChecklistLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} style={checklistLinkStyle}>
      {children}
    </Link>
  )
}

export function ChecklistComingSoon({ label }: { label: string }) {
  return (
    <span style={checklistDisabledStyle}>
      {label}
      <span
        style={{
          fontSize: 10,
          padding: "1px 5px",
          borderRadius: 3,
          background: "rgba(120,120,140,0.2)",
        }}
      >
        Coming soon
      </span>
    </span>
  )
}

const cardStyle: CSSProperties = {
  padding: 24,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  marginBottom: 16,
}

const stepRowStyle: CSSProperties = {
  padding: 14,
  borderRadius: 8,
  border: "1px solid var(--border)",
}

const stepNumberStyle: CSSProperties = {
  flexShrink: 0,
  width: 28,
  height: 28,
  borderRadius: "50%",
  border: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--dim)",
}
