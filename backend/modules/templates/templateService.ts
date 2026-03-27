// ─────────────────────────────────────────────────────────────
// templateService.ts
// ─────────────────────────────────────────────────────────────

import type {
  TemplateId,
  TemplateInput,
  TemplateRenderResult,
  TEMPLATE_IDS
} from "./templateTypes"
import { TEMPLATE_IDS as TMAP } from "./templateTypes"

// ─── SANITIZERS ───────────────────────────────────────────────

export function sanitizeText(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .trim()
}

export function sanitizeHtml(html: string): string {
  // Script ve iframe etiketlerini kaldır
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/on\w+="[^"]*"/gi, "")
    .replace(/javascript:/gi, "")
    .trim()
}

export function removeAmazonArtifacts(text: string): string {
  return text
    // Amazon URL'leri
    .replace(/https?:\/\/(www\.)?(amazon|amzn)\.[a-z.]+[^\s"]*/gi, "")
    // ASIN referansları
    .replace(/\b[A-Z0-9]{10}\b/g, "")
    // "as seen on Amazon" türü ifadeler
    .replace(/\b(amazon|amzn|sold by amazon|fulfilled by amazon|amazon\.com)\b/gi, "")
    // "Visit the X Store" Amazon store linkleri
    .replace(/visit the .{1,40} store/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
}

// ─── INPUT HELPERS ────────────────────────────────────────────

function clean(val: string | null | undefined): string {
  if (!val) return ""
  return sanitizeText(removeAmazonArtifacts(val))
}

function bullets(input: TemplateInput): string[] {
  if (!input.bullets || input.bullets.length === 0) return []
  return input.bullets
    .map(b => removeAmazonArtifacts(b).trim())
    .filter(b => b.length > 0)
    .map(b => sanitizeText(b))
}

function resolveTemplateId(raw: string | null | undefined): TemplateId {
  if (!raw) return "minimal_clean"
  if (raw in TMAP) return TMAP[raw as keyof typeof TMAP]
  const valid: TemplateId[] = ["minimal_clean", "modern_sales", "premium_brand", "minimal_pro"]
  return valid.includes(raw as TemplateId) ? (raw as TemplateId) : "minimal_clean"
}

// ─── SHARED STYLE TOKENS ──────────────────────────────────────

const BASE_RESET = `font-family:Arial,Helvetica,sans-serif;margin:0;padding:0;box-sizing:border-box;`

// ─── TEMPLATE 1: MINIMAL CLEAN ────────────────────────────────

function renderMinimalClean(input: TemplateInput): string {
  const title  = clean(input.title)
  const brand  = clean(input.brand ?? "")
  const bs     = bullets(input)
  const ship   = clean(input.shippingNote ?? "")
  const ret    = clean(input.returnNote ?? "")
  const note   = clean(input.sellerNote ?? "")

  const bulletHtml = bs.length > 0
    ? `<ul style="margin:8px 0 0 0;padding-left:20px;color:#444;font-size:14px;line-height:1.7">
        ${bs.map(b => `<li>${b}</li>`).join("\n        ")}
       </ul>`
    : ""

  const metaRows = [
    ship ? `<tr><td style="padding:4px 12px 4px 0;color:#888;font-size:12px;white-space:nowrap">🚚 Shipping</td><td style="font-size:13px;color:#444">${ship}</td></tr>` : "",
    ret  ? `<tr><td style="padding:4px 12px 4px 0;color:#888;font-size:12px;white-space:nowrap">🔄 Returns</td><td style="font-size:13px;color:#444">${ret}</td></tr>` : "",
    note ? `<tr><td style="padding:4px 12px 4px 0;color:#888;font-size:12px;white-space:nowrap">📝 Note</td><td style="font-size:13px;color:#444">${note}</td></tr>` : "",
  ].filter(Boolean).join("\n")

  return `<div style="${BASE_RESET}max-width:680px;padding:20px;background:#fff;color:#222">
  ${brand ? `<p style="margin:0 0 4px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#999">${brand}</p>` : ""}
  <h2 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#111;line-height:1.3">${title}</h2>
  ${bulletHtml}
  ${metaRows ? `<table style="margin-top:16px;border-collapse:collapse;width:100%">${metaRows}</table>` : ""}
</div>`
}

// ─── TEMPLATE 2: MODERN SALES ─────────────────────────────────

function renderModernSales(input: TemplateInput): string {
  const title  = clean(input.title)
  const brand  = clean(input.brand ?? "")
  const bs     = bullets(input)
  const ship   = clean(input.shippingNote ?? "")
  const ret    = clean(input.returnNote ?? "")
  const note   = clean(input.sellerNote ?? "")

  const featureHtml = bs.length > 0
    ? `<div style="margin:16px 0;padding:16px;background:#f8f9fa;border-radius:6px">
       <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#0064d2">Key Features</p>
       <ul style="margin:0;padding-left:18px;color:#333;font-size:14px;line-height:1.8">
         ${bs.map(b => `<li>${b}</li>`).join("\n         ")}
       </ul>
     </div>`
    : ""

  const badges = [
    ship ? `<span style="display:inline-block;margin:4px 6px 4px 0;padding:5px 12px;background:#e8f4fd;color:#0064d2;border-radius:20px;font-size:12px;font-weight:600">${ship}</span>` : "",
    ret  ? `<span style="display:inline-block;margin:4px 6px 4px 0;padding:5px 12px;background:#e8f7ee;color:#006e37;border-radius:20px;font-size:12px;font-weight:600">${ret}</span>` : "",
  ].filter(Boolean).join("")

  return `<div style="${BASE_RESET}max-width:680px;padding:0;background:#fff;color:#111">
  <div style="padding:20px 20px 0">
    ${brand ? `<span style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#0064d2">${brand}</span>` : ""}
    <h2 style="margin:${brand ? "6px" : "0"} 0 0;font-size:20px;font-weight:700;color:#111;line-height:1.3">${title}</h2>
  </div>
  ${featureHtml ? `<div style="padding:0 20px">${featureHtml}</div>` : ""}
  ${badges ? `<div style="padding:0 20px 16px">${badges}</div>` : ""}
  ${note ? `<div style="margin:0 20px 20px;padding:12px 16px;background:#fff8e7;border-left:3px solid #f5a623;font-size:13px;color:#555">${note}</div>` : ""}
</div>`
}

// ─── TEMPLATE 3: PREMIUM BRAND ────────────────────────────────

function renderPremiumBrand(input: TemplateInput): string {
  const title  = clean(input.title)
  const brand  = clean(input.brand ?? "")
  const bs     = bullets(input)
  const ship   = clean(input.shippingNote ?? "")
  const ret    = clean(input.returnNote ?? "")
  const note   = clean(input.sellerNote ?? "")

  const featureItems = bs.map(b =>
    `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #f0f0f0">
       <span style="color:#333;font-size:18px;flex-shrink:0;line-height:1.2">◆</span>
       <span style="font-size:14px;color:#333;line-height:1.5">${b}</span>
     </div>`
  ).join("\n")

  const infoBlock = [
    ship ? `<div style="padding:10px 0;border-bottom:1px solid #eee"><span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#999">Shipping</span><p style="margin:4px 0 0;font-size:13px;color:#444">${ship}</p></div>` : "",
    ret  ? `<div style="padding:10px 0;border-bottom:1px solid #eee"><span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#999">Returns</span><p style="margin:4px 0 0;font-size:13px;color:#444">${ret}</p></div>` : "",
    note ? `<div style="padding:10px 0"><span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#999">Seller Note</span><p style="margin:4px 0 0;font-size:13px;color:#444">${note}</p></div>` : "",
  ].filter(Boolean).join("")

  return `<div style="${BASE_RESET}max-width:680px;background:#fff;color:#111">
  <div style="padding:24px 24px 16px;border-bottom:2px solid #111">
    ${brand ? `<p style="margin:0 0 6px;font-size:10px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:#888">${brand}</p>` : ""}
    <h2 style="margin:0;font-size:22px;font-weight:700;color:#111;line-height:1.25;letter-spacing:-0.3px">${title}</h2>
  </div>
  ${featureItems ? `<div style="padding:8px 24px 16px">${featureItems}</div>` : ""}
  ${infoBlock ? `<div style="padding:0 24px 24px">${infoBlock}</div>` : ""}
</div>`
}

// ─── TEMPLATE 4: MINIMAL PRO ──────────────────────────────────

function renderMinimalPro(input: TemplateInput): string {
  const title  = clean(input.title)
  const brand  = clean(input.brand ?? "")
  const bs     = bullets(input)
  const ship   = clean(input.shippingNote ?? "")
  const ret    = clean(input.returnNote ?? "")
  const note   = clean(input.sellerNote ?? "")

  const bulletGrid = bs.length > 0
    ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:16px 0">
        ${bs.map(b =>
          `<div style="padding:10px 12px;background:#f5f5f5;border-radius:4px;font-size:13px;color:#333;line-height:1.4">${b}</div>`
        ).join("\n        ")}
       </div>`
    : ""

  const footer = [
    ship ? `<span style="font-size:12px;color:#666;margin-right:16px">✓ ${ship}</span>` : "",
    ret  ? `<span style="font-size:12px;color:#666;margin-right:16px">✓ ${ret}</span>` : "",
  ].filter(Boolean).join("")

  return `<div style="${BASE_RESET}max-width:680px;padding:20px;background:#fff;color:#111">
  <div style="margin-bottom:16px">
    ${brand ? `<span style="font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#0070ba;margin-right:8px">${brand}</span>` : ""}
    <h2 style="display:inline;font-size:17px;font-weight:600;color:#111;line-height:1.4">${title}</h2>
  </div>
  ${bulletGrid}
  ${note ? `<p style="margin:12px 0 0;padding:10px 14px;background:#f0f7ff;border-radius:4px;font-size:13px;color:#555;line-height:1.5">${note}</p>` : ""}
  ${footer ? `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #eee">${footer}</div>` : ""}
</div>`
}

// ─── MAIN RENDER ──────────────────────────────────────────────

export function renderTemplate(
  templateIdRaw: TemplateId | string | null | undefined,
  input:         TemplateInput
): TemplateRenderResult {
  const templateId = resolveTemplateId(templateIdRaw ?? input.templateId)

  let html: string

  switch (templateId) {
    case "minimal_clean":  html = renderMinimalClean(input);  break
    case "modern_sales":   html = renderModernSales(input);   break
    case "premium_brand":  html = renderPremiumBrand(input);  break
    case "minimal_pro":    html = renderMinimalPro(input);    break
    default:               html = renderMinimalClean(input);
  }

  return {
    templateId,
    html:      sanitizeHtml(html),
    charCount: html.length,
  }
}
