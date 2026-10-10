import type { ReactNode } from "react"

type AppHelpBoxProps = {
  title?: string
  items?: string[]
  text?: string
  children?: ReactNode
}

export function AppHelpBox({ title = "How it works", items, text, children }: AppHelpBoxProps) {
  return (
    <aside className="app-help-box" aria-label={title}>
      <p className="app-help-box-title">{title}</p>
      {items && items.length > 0 ? (
        <ol className="app-help-box-list">
          {items.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      ) : text ? (
        <p className="app-help-box-text">{text}</p>
      ) : (
        children
      )}
    </aside>
  )
}
