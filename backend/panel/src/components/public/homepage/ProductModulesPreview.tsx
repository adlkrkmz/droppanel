const MODULES = [
  {
    title: 'Discovery',
    desc: 'Surface niches and ASIN clusters before competitors saturate the listing window.',
    tag: 'SCAN',
  },
  {
    title: 'Analysis',
    desc: 'Saturation, seasonality, and demand signals in one operational view.',
    tag: 'SCORE',
  },
  {
    title: 'Dispatch',
    desc: 'Route ready inventory to the right stores with controlled job orchestration.',
    tag: 'SHIP',
  },
  {
    title: 'Monitor',
    desc: 'Track listing health, margins, and pipeline stage without tab switching.',
    tag: 'OPS',
  },
] as const

export default function ProductModulesPreview() {
  return (
    <section className="lj-modules" id="modules">
      <h2>Operations platform</h2>
      <p className="lj-modules-sub">
        Ambient intelligence supports the scanner — the terminal ties discovery to dispatch.
      </p>
      <div className="lj-modules-grid">
        {MODULES.map((m) => (
          <article key={m.title} className="lj-module-card">
            <h3>{m.title}</h3>
            <p>{m.desc}</p>
            <span className="lj-module-tag">{m.tag}</span>
          </article>
        ))}
      </div>
    </section>
  )
}
