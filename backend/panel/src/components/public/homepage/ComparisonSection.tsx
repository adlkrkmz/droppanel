import SurfaceReveal from './SurfaceReveal'
import {
  COMPARISON_EYEBROW,
  COMPARISON_HEADLINE,
  COMPARISON_SUPPORT,
  COMPARISON_WITHOUT_LABEL,
  COMPARISON_WITHOUT_ROWS,
  COMPARISON_WITH_LABEL,
  COMPARISON_WITH_ROWS,
} from './homepage-copy'

export default function ComparisonSection() {
  return (
    <SurfaceReveal className="ops-compare" id="operations">
      <div id="platform" className="ops-anchor" aria-hidden />
      <div className="ops-compare-inner">
        <header className="ops-compare-header">
          <p className="ops-compare-eyebrow">{COMPARISON_EYEBROW}</p>
          <h2 className="ops-compare-title">{COMPARISON_HEADLINE}</h2>
          <p className="ops-compare-intro">{COMPARISON_SUPPORT}</p>
        </header>

        <div className="ops-compare-board">
          <article className="ops-compare-panel ops-compare-col--without">
            <p className="ops-compare-label">{COMPARISON_WITHOUT_LABEL}</p>
            <ul className="ops-compare-list ops-compare-list--compact">
              {COMPARISON_WITHOUT_ROWS.map((row) => (
                <li key={row} className="ops-compare-item">
                  {row}
                </li>
              ))}
            </ul>
          </article>

          <article className="ops-compare-panel ops-compare-col--with">
            <p className="ops-compare-label">{COMPARISON_WITH_LABEL}</p>
            <ul className="ops-compare-list ops-compare-list--compact">
              {COMPARISON_WITH_ROWS.map((row) => (
                <li key={row} className="ops-compare-item">
                  {row}
                </li>
              ))}
            </ul>
          </article>
        </div>
      </div>
    </SurfaceReveal>
  )
}
