import crypto from "crypto"

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

function decodeBase32(input: string): Buffer {
  const cleaned = input.replace(/\s+/g, "").replace(/=+$/g, "").toUpperCase()
  let bits = ""
  for (const ch of cleaned) {
    const idx = BASE32.indexOf(ch)
    if (idx < 0) continue
    bits += idx.toString(2).padStart(5, "0")
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}

export function generateTotpCode(secret: string, nowMs = Date.now()): string {
  const key = decodeBase32(normalizeTotpSecret(secret))
  const counter = Math.floor(nowMs / 1000 / 30)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const hmac = crypto.createHmac("sha1", key).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return String(bin % 1_000_000).padStart(6, "0")
}

export function normalizeTotpSecret(secret: string): string {
  const trimmed = secret.trim()
  const fromUri = trimmed.match(/[?&]secret=([^&]+)/i)
  const raw = fromUri ? decodeURIComponent(fromUri[1]) : trimmed
  return raw.replace(/\s+/g, "").toUpperCase()
}
