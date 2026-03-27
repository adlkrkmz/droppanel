// ─────────────────────────────────────────────────────────────
// imageProcessorService.ts
//
// sharp ile görsel indirme, resize (2000x2000 contain, beyaz arka plan),
// ilk görsele "FREE SHIPPING" overlay (beyaz, siyah outline, 60px bold).
// processAndUploadImages: her görsel 1600 JPEG → R2; R2/indirme hatası → Amazon URL.
// ─────────────────────────────────────────────────────────────

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import sharp from "sharp"
import type { ImageProcessorInput, ImageProcessorOutput, ProcessedImage } from "./imageProcessorTypes"

const MAX_IMAGES = 10
const TARGET_SIZE = 2000
const OVERLAY_PADDING = 30
const OVERLAY_FONT_SIZE = 60

function isVideoThumbnailUrl(url: string): boolean {
  const u = url.toLowerCase()
  return (
    u.includes("pkplay-button") ||
    u.includes("play-button") ||
    u.includes("_sx75_") ||
    u.includes("_sy75_") ||
    u.includes("_ss75_") ||
    u.includes("sprite") ||
    u.includes("_rc_") ||
    u.includes("pibundle") ||
    (u.includes("_ac_") && !u.includes("_ac_sl"))
  )
}

function upscaleAmazonImageUrl(url: string): string {
  // _AC_SL ile biten boyutları SL1500 yap
  if (url.includes("._AC_SL")) {
    return url.replace(/_AC_SL\d+_/g, "_AC_SL1500_")
  }

  // _AC_ varsa SL1500 ekle
  if (url.includes("._AC_")) {
    return url.replace(/\._AC_[^.]*\./g, "._AC_SL1500_.")
  }

  // SS boyutları
  if (/SS\d+_/i.test(url)) {
    return url.replace(/SS\d+_/gi, "SL1500_")
  }

  return url
}

/**
 * Buffer'ı R2'ye yükler; herkese açık URL döner.
 * Key: listings/{fileName}, Content-Type: uzantıya göre (jpg/jpeg → image/jpeg, png → image/png)
 */
export async function uploadToR2(buffer: Buffer, fileName: string): Promise<string> {
  const endpoint = process.env.R2_ENDPOINT
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.R2_BUCKET_NAME
  const publicBase = process.env.R2_PUBLIC_URL

  if (!endpoint?.trim()) {
    throw new Error("R2_ENDPOINT is not set")
  }
  if (!accessKeyId?.trim() || !secretAccessKey?.trim()) {
    throw new Error("R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are not set")
  }
  if (!bucket?.trim()) {
    throw new Error("R2_BUCKET_NAME is not set")
  }
  if (!publicBase?.trim()) {
    throw new Error("R2_PUBLIC_URL is not set")
  }

  const client = new S3Client({
    region: "auto",
    endpoint: endpoint.trim(),
    credentials: {
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secretAccessKey.trim(),
    },
  })

  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  const contentType =
    ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : "application/octet-stream"

  const key = `listings/${fileName}`
  await client.send(
    new PutObjectCommand({
      Bucket: bucket.trim(),
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  )

  let base = publicBase.trim().replace(/\/+$/, "")
  if (base.startsWith("http://")) {
    base = `https://${base.slice("http://".length)}`
  } else if (!/^https?:\/\//i.test(base)) {
    base = `https://${base}`
  }
  return `${base}/listings/${fileName}`
}

/**
 * URL'den görsel indirir, buffer döndürür.
 */
export async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  })
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`)
  }
  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

/**
 * "FREE SHIPPING" SVG overlay (beyaz, siyah outline, bold 60px).
 */
function createFreeShippingOverlaySvg(): Buffer {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="480" height="100">
  <text
    x="0"
    y="72"
    font-size="${OVERLAY_FONT_SIZE}"
    font-weight="bold"
    fill="white"
    stroke="black"
    stroke-width="3"
  >FREE SHIPPING</text>
</svg>
`.trim()
  return Buffer.from(svg)
}

/**
 * Tek görseli işler: 2000x2000 contain (beyaz arka plan).
 * isFirst true ise sol üst köşeye (30px padding) "FREE SHIPPING" overlay eklenir.
 */
export async function processImage(
  buffer: Buffer,
  isFirst: boolean,
  originalUrl: string
): Promise<ProcessedImage> {
  let pipeline = sharp(buffer).resize(TARGET_SIZE, TARGET_SIZE, {
    fit: "contain",
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  })

  if (isFirst) {
    const overlaySvg = createFreeShippingOverlaySvg()
    const overlayBuffer = await sharp(overlaySvg).png().toBuffer()
    pipeline = pipeline.composite([
      {
        input: overlayBuffer,
        left:   OVERLAY_PADDING,
        top:    OVERLAY_PADDING,
      },
    ])
  }

  const out = await pipeline.png().toBuffer()
  const meta = await sharp(out).metadata()
  const width = meta.width ?? TARGET_SIZE
  const height = meta.height ?? TARGET_SIZE

  return {
    originalUrl,
    buffer: out,
    width,
    height,
  }
}

/**
 * En fazla 10 görseli paralel indirir ve işler. Hata alan URL'ler atlanır.
 */
export async function processProductImages(input: ImageProcessorInput): Promise<ImageProcessorOutput> {
  const urls = input.imageUrls
    .filter((u) => typeof u === "string")
    .map((u) => u.trim())
    .filter((u) => u.length > 0)
    .filter((u) => !isVideoThumbnailUrl(u))
    .map(upscaleAmazonImageUrl)
    .slice(0, MAX_IMAGES)

  const results = await Promise.allSettled(
    urls.map(async (url, index) => {
      const buffer = await downloadImage(url)
      return processImage(buffer, index === 0, url)
    })
  )

  const processedImages: ProcessedImage[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === "fulfilled") {
      processedImages.push(r.value)
    } else {
      console.warn(`[ImageProcessor] Skip image ${urls[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
    }
  }

  return { processedImages }
}

/**
 * Her görsel: indir → max 1600×1600 inside → JPEG %92 → R2 (paralel, Promise.allSettled).
 * R2 veya işleme hatasında upscale edilmiş Amazon URL kullanılır (fallback); sıra ve uzunluk korunur.
 */
export async function processAndUploadImages(input: ImageProcessorInput): Promise<string[]> {
  const urls = input.imageUrls
    .filter((u) => typeof u === "string" && u.trim().length > 0)
    .filter((u) => !isVideoThumbnailUrl(u))
    .map(upscaleAmazonImageUrl)
    .slice(0, MAX_IMAGES)

  if (urls.length === 0) return []

  const results = await Promise.allSettled(
    urls.map(async (url, i) => {
      const buffer = await downloadImage(url)
      const processed = await sharp(buffer)
        .resize(1600, 1600, {
          fit:               "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 92, mozjpeg: false })
        .toBuffer()
      const fileName = input.asin + "-" + (i + 1) + ".jpg"
      return await uploadToR2(processed, fileName)
    })
  )

  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
    console.warn(
      `[ImageProcessor] processAndUploadImages slot ${i + 1}/${urls.length} failed, using Amazon URL: ${msg}`
    )
    return urls[i]
  })
}
