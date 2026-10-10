import PublicFooter from '@/components/public/PublicFooter'
import HomepageNav from './HomepageNav'
import {
  DEMAND_LABEL,
  HERO_ARTWORK_HEIGHT,
  HERO_ARTWORK_SRC,
  HERO_ARTWORK_WIDTH,
  LANDING_FEATURES,
  landingMarketData,
  landingStats,
  type DemandLevel,
} from './landingMarketData'

function demandClass(level: DemandLevel) {
  return `lj-land-cat-demand lj-land-cat-demand--${level}`
}

/**
 * Approved Penpot public landing. Placeholder market/KPI values live in landingMarketData.ts
 * and are not live backend data.
 */
export default function ListJetGoHomePage() {
  return (
    <div className="pub">
      <div className="lj-land ops-home" data-ops-css-root="homepage">
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap"
        />
        <HomepageNav />
        <div className="lj-land-divider" />

        <section className="lj-land-hero" id="platform" aria-labelledby="lj-land-heading">
          <div className="lj-land-copy">
            <p className="lj-land-eyebrow">
              <span className="lj-land-dot" aria-hidden="true" />
              eBay operasyon platformu
            </p>
            <h1 id="lj-land-heading" className="lj-land-h1">
              <span className="lj-land-h1-line">eBay operasyonunu</span>
              <span className="lj-land-h1-line lj-land-h1-line--accent">tek merkezden yönet.</span>
            </h1>
            <p className="lj-land-body">
              Stok, fiyat, sipariş ve ürün keşfi için akıllı kontrol paneli.
            </p>
            <div className="lj-land-cta-row" id="access">
              <a href="/register?product=ebay" className="lj-land-cta-primary">
                14 Gün Ücretsiz Dene
              </a>
              <a href="/demo" className="lj-land-cta-secondary">
                <span className="lj-land-dot" aria-hidden="true" />
                Canlı Demo
              </a>
            </div>
            <div className="lj-land-trust">
              <span className="lj-land-trust-item">
                <span className="lj-land-dot" aria-hidden="true" />
                Kolay kurulum
              </span>
              <span className="lj-land-trust-item">
                <span className="lj-land-dot" aria-hidden="true" />
                Stok, fiyat, sipariş
              </span>
              <span className="lj-land-trust-item">
                <span className="lj-land-dot" aria-hidden="true" />
                Çoklu eBay mağazası
              </span>
            </div>
          </div>

          <div className="lj-land-art">
            <img
              className="lj-land-art-img"
              src={HERO_ARTWORK_SRC}
              alt="ListJetGo marketplace visualization with motors, electronics, home, fashion, and collectibles sectors"
              width={HERO_ARTWORK_WIDTH}
              height={HERO_ARTWORK_HEIGHT}
              decoding="async"
              fetchPriority="high"
            />
            <div className="lj-land-overlays">
            <div className="lj-land-live" id="intelligence">
              <div className="lj-land-live-top">
                <span className="lj-land-dot lj-land-live-dot" aria-hidden="true" />
                <span className="lj-land-live-label">CANLI PİYASA HARİTASI</span>
              </div>
              <span className="lj-land-live-hint">Veriler periyodik olarak güncellenir</span>
            </div>

            {landingMarketData.categories.map(cat => (
              <article
                key={cat.id}
                className={`lj-land-overlay lj-land-overlay--${cat.id}`}
                aria-label={`${cat.name} category overlay`}
              >
                <span className="lj-land-cat-name">{cat.name}</span>
                <span className="lj-land-cat-sales">{cat.salesVolume}</span>
                <div className="lj-land-cat-meta">
                  <span className="lj-land-cat-growth">+{cat.growthPercent}%</span>
                  <span className={demandClass(cat.demandLevel)}>
                    <span className="lj-land-marker" aria-hidden="true" />
                    {DEMAND_LABEL[cat.demandLevel]}
                  </span>
                </div>
              </article>
            ))}

            <div className="lj-land-hub" aria-hidden="true">
              ListJetGo
            </div>

            <div className="lj-land-legend" aria-label="Demand legend">
              <div className="lj-land-legend-row">
                <span className="lj-land-legend-dot" style={{ background: '#3DDC97' }} aria-hidden="true" />
                Yüksek Talep
              </div>
              <div className="lj-land-legend-row">
                <span className="lj-land-legend-dot" style={{ background: '#E8B86D' }} aria-hidden="true" />
                Orta Talep
              </div>
              <div className="lj-land-legend-row">
                <span className="lj-land-legend-dot" style={{ background: '#5B6B7C' }} aria-hidden="true" />
                Düşük Talep
              </div>
            </div>
            </div>
          </div>
        </section>

        <section className="lj-land-stats" aria-label="Örnek veri slotları">
          <p className="lj-land-stats-note">
            <span className="lj-land-dot" aria-hidden="true" />
            Örnek veri slotları — canlı bağlanınca güncellenir
          </p>
          <div className="lj-land-stats-row">
            {landingStats.map(stat => (
              <article key={stat.id} className="lj-land-stat">
                <span className="lj-land-stat-label">{stat.label}</span>
                <span className="lj-land-stat-value">{stat.value}</span>
                <span className="lj-land-stat-delta">{stat.delta}</span>
              </article>
            ))}
          </div>
        </section>

        <section className="lj-land-features" id="operations" aria-label="Product capabilities">
          {LANDING_FEATURES.map(feature => (
            <article key={feature.title} className="lj-land-feature">
              <span className="lj-land-feature-icon" aria-hidden="true">
                <span />
              </span>
              <h2 className="lj-land-feature-title">{feature.title}</h2>
              <p className="lj-land-feature-body">{feature.body}</p>
            </article>
          ))}
        </section>

        <PublicFooter variant="listjetgo" />
      </div>
    </div>
  )
}
