import fs   from "fs"
import path  from "path"
import { renderTemplate } from "./modules/templates/templateService"
import type { TemplateInput } from "./modules/templates/templateTypes"

// ─── SAMPLE INPUT ─────────────────────────────────────────────

const SAMPLE: TemplateInput = {
  title:        "Premium Wireless Noise Cancelling Headphones",
  brand:        "SoundPro",
  bullets: [
    "Active noise cancellation blocks up to 95% of ambient sound",
    "40-hour battery life with quick charge (10 min = 3 hours)",
    "Ultra-soft memory foam ear cushions for all-day comfort",
    "Foldable design with premium carrying case included",
    "Compatible with all Bluetooth 5.0 devices",
  ],
  sellerNote:   "Ships in original sealed packaging. Condition: New.",
  shippingNote: "Fast & Free Shipping — Delivered in 2–4 business days",
  returnNote:   "30-day hassle-free returns accepted",
  imageUrls: [
    "https://example.com/images/headphones-1.jpg",
    "https://example.com/images/headphones-2.jpg",
  ],
}

// Amazon artifact testi için
const DIRTY_INPUT: TemplateInput = {
  ...SAMPLE,
  title:  "Best Headphones — as seen on Amazon.com Visit the SoundPro Store",
  brand:  "SoundPro (sold by amazon)",
  bullets: [
    "Buy on amazon.com/dp/B08XYZ1234",
    "Fulfilled by Amazon — ships in 2 days",
    "Check our Amazon store for more deals",
  ],
}

// ─── HELPERS ──────────────────────────────────────────────────

function sep(len = 68): void {
  console.log("  " + "─".repeat(len))
}

const TEMPLATE_IDS = ["1", "2", "3", "4"] as const
const TEMPLATE_NAMES: Record<string, string> = {
  "1": "minimal_clean",
  "2": "modern_sales",
  "3": "premium_brand",
  "4": "minimal_pro",
}

// ─── MAIN ─────────────────────────────────────────────────────

function main(): void {
  console.log("═".repeat(68))
  console.log("  test-template-engine")
  console.log("═".repeat(68))
  console.log("")

  const previewParts: string[] = [`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Template Engine Preview</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #e8e8e8; padding: 32px 16px; }
    .wrapper { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 32px; }
    .card { background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
    .card-header { padding: 12px 20px; background: #1a1a1a; color: #fff; display: flex; justify-content: space-between; align-items: center; }
    .card-header .name { font-size: 13px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #aaa; }
    .card-header .chars { font-size: 11px; color: #666; }
    .card-body { padding: 0; }
  </style>
</head>
<body>
<div class="wrapper">`]

  // ── 4 template render ─────────────────────────────────────────

  console.log("  ► 4 Template — Normal Input")
  console.log(
    `  ${"#".padEnd(4)}` +
    `${"Template".padEnd(18)}` +
    `${"Chars".padEnd(8)}` +
    `Status`
  )
  sep()

  for (const id of TEMPLATE_IDS) {
    const result = renderTemplate(id, SAMPLE)
    console.log(
      `  ${id.padEnd(4)}` +
      `${result.templateId.padEnd(18)}` +
      `${String(result.charCount).padEnd(8)}` +
      `✓`
    )

    previewParts.push(`
  <div class="card">
    <div class="card-header">
      <span class="name">Template ${id} — ${result.templateId}</span>
      <span class="chars">${result.charCount} chars</span>
    </div>
    <div class="card-body">${result.html}</div>
  </div>`)
  }

  // ── Kirli input testi ─────────────────────────────────────────

  console.log("")
  console.log("  ► Amazon Artifact Removal Test (template 2)")
  sep()

  const dirtyResult = renderTemplate("2", DIRTY_INPUT)
  const hasAmazon = dirtyResult.html.toLowerCase().includes("amazon")
  console.log(`  Amazon artifacts removed : ${hasAmazon ? "✗ STILL PRESENT" : "✓ CLEAN"}`)
  console.log(`  Output chars             : ${dirtyResult.charCount}`)

  previewParts.push(`
  <div class="card">
    <div class="card-header">
      <span class="name">Artifact Test — modern_sales (dirty input)</span>
      <span class="chars">${hasAmazon ? "⚠ amazon present" : "✓ clean"} · ${dirtyResult.charCount} chars</span>
    </div>
    <div class="card-body">${dirtyResult.html}</div>
  </div>`)

  // ── Minimal input testi ───────────────────────────────────────

  console.log("")
  console.log("  ► Graceful Fallback Test (minimal input, template 3)")
  sep()

  const minimalResult = renderTemplate("3", {
    title:  "Generic Product",
    brand:  null,
    bullets: [],
  })
  console.log(`  Rendered without error : ✓`)
  console.log(`  Output chars           : ${minimalResult.charCount}`)

  previewParts.push(`
  <div class="card">
    <div class="card-header">
      <span class="name">Fallback Test — premium_brand (minimal input)</span>
      <span class="chars">${minimalResult.charCount} chars</span>
    </div>
    <div class="card-body">${minimalResult.html}</div>
  </div>`)

  // ── HTML preview dosyası ──────────────────────────────────────

  previewParts.push(`
</div>
</body>
</html>`)

  const outDir  = path.join(__dirname, "template-previews")
  const outFile = path.join(outDir, "preview.html")

  try {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(outFile, previewParts.join("\n"), "utf8")
    console.log("")
    console.log(`  ► HTML Preview saved`)
    sep()
    console.log(`  ${outFile}`)
    console.log("  Tarayıcıda aç → tüm template'leri yan yana gör")
  } catch {
    console.log("  (preview dosyası yazılamadı — devam)")
  }

  // ── Final ─────────────────────────────────────────────────────

  console.log("")
  console.log("═".repeat(68))
  console.log("  4 template üretildi: minimal_clean · modern_sales · premium_brand · minimal_pro")
  console.log("  Sonraki adım: ebayPayloadService.description → renderTemplate() entegrasyonu")
  console.log("═".repeat(68))
}

main()
