/**
 * Merges homepage source CSS into one file (no @import).
 * Run: node scripts/bundle-homepage-css.mjs
 * Auto-runs before production build via package.json prebuild.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'src/components/public/homepage')

const HEALTH_MARKER = `/*
 * HOMEPAGE CSS BUNDLE — AUTO-GENERATED. DO NOT EDIT DIRECTLY.
 * Edit: landing-hero.css
 * Then: npm run bundle:homepage-css
 *
 * Import ONLY from: src/app/page.tsx
 *
 * Health check (DevTools):
 *   getComputedStyle(document.querySelector('.ops-home')).getPropertyValue('--ops-css-health')
 *   → should return "loaded"
 */

/* Fail-safe: ambient labels must not show as raw inline text if bundle fails */
.ops-ambient-labels {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
}

.ops-home {
  --ops-css-health: loaded;
}

`

const sources = [
  { name: 'landing-hero.css', file: 'landing-hero.css' },
]

let body = HEALTH_MARKER

for (const { name, file } of sources) {
  const filePath = path.join(outDir, file)
  const content = fs.readFileSync(filePath, 'utf8')
  body += `\n/* ========== ${name} ========== */\n\n${content}\n`
}

const outPath = path.join(outDir, 'homepage-entry.css')
fs.writeFileSync(outPath, body, 'utf8')
console.log(`Wrote ${outPath} (${body.length} bytes)`)
