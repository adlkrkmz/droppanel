import HeroBackground from './infrastructure/HeroBackground'

import { HERO_HEADLINE, HERO_SUBHEADLINE } from './homepage-copy'



/** Phase 1 hero — product-aware registration CTAs; sign-in stays generic in nav. */

export default function HeroSection() {

  return (

    <section className="ops-hero" aria-labelledby="ops-hero-heading">

      <HeroBackground />

      <div className="ops-hero-inner">

        <p className="ops-hero-eyebrow">Commerce operations infrastructure</p>

        <h1 id="ops-hero-heading">{HERO_HEADLINE}</h1>

        <p className="ops-hero-lead">{HERO_SUBHEADLINE}</p>

        <div className="ops-hero-ctas">

          <a href="/register?product=ebay" className="ops-btn ops-btn--primary">

            Start with eBay

          </a>

        </div>

      </div>

    </section>

  )

}

