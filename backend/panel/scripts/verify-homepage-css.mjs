/**
 * Post-build smoke test: homepage CSS must be in production bundle.
 * Run: npm run verify:homepage-css (after npm run build)
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const panelRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const chunksDir = path.join(panelRoot, '.next', 'static', 'chunks')
const entryPath = path.join(panelRoot, 'src/components/public/homepage/homepage-entry.css')

const REQUIRED_IN_CHUNK = ['.lj-land', '.lj-land-nav', '--ops-css-health']

const FORBIDDEN_IN_ENTRY = ['@import']

function fail(msg) {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

if (!fs.existsSync(entryPath)) {
  fail(`missing ${entryPath} — run npm run bundle:homepage-css`)
}

const entry = fs.readFileSync(entryPath, 'utf8')
if (entry.includes('@import')) {
  fail('homepage-entry.css must not use @import — run npm run bundle:homepage-css')
}

for (const token of REQUIRED_IN_CHUNK) {
  if (!entry.includes(token)) {
    fail(`homepage-entry.css missing "${token}" — run npm run bundle:homepage-css`)
  }
}

if (!fs.existsSync(chunksDir)) {
  fail('.next/static/chunks not found — run npm run build first')
}

const cssFiles = fs.readdirSync(chunksDir).filter((f) => f.endsWith('.css'))
let homepageChunk = null

for (const file of cssFiles) {
  const content = fs.readFileSync(path.join(chunksDir, file), 'utf8')
  const ok = REQUIRED_IN_CHUNK.every((t) => content.includes(t))
  if (ok) {
    homepageChunk = { file, size: content.length }
    break
  }
}

if (!homepageChunk) {
  fail(
    `no production CSS chunk contains all: ${REQUIRED_IN_CHUNK.join(', ')}\n` +
      `Chunks checked: ${cssFiles.join(', ')}`
  )
}

const globalsOnly = cssFiles.filter((f) => {
  const c = fs.readFileSync(path.join(chunksDir, f), 'utf8')
  return c.includes('.pub') && !c.includes('.lj-land-nav')
})

console.log('OK: homepage-entry.css is flat (no @import)')
console.log(`OK: homepage CSS in chunk ${homepageChunk.file} (${homepageChunk.size} bytes)`)
console.log(`OK: globals chunk separate (${globalsOnly.length} file(s))`)
console.log('OK: --ops-css-health marker present for DevTools inspection')
