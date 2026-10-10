type ModeStatusRowProps = {
  segments: string[]
}

export default function ModeStatusRow({ segments }: ModeStatusRowProps) {
  return (
    <div className="ops-mode-status" aria-label="Operational status">
      {segments.map((seg, i) => (
        <span key={seg} className="ops-mode-status-segment">
          {i > 0 ? <span className="ops-mode-status-sep" aria-hidden> · </span> : null}
          {seg}
        </span>
      ))}
    </div>
  )
}
