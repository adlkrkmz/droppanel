import crypto from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12

function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const key = Buffer.from(trimmed, 'hex')
    if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY hex must decode to 32 bytes')
    return key
  }

  const key = Buffer.from(trimmed, 'base64')
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes (base64 or 64-char hex)')
  }
  return key
}

let cachedKey: Buffer | null = null

export function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey

  const raw = process.env.TOKEN_ENCRYPTION_KEY?.trim()
  if (raw) {
    cachedKey = parseEncryptionKey(raw)
    return cachedKey
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('TOKEN_ENCRYPTION_KEY is required in production')
  }

  console.warn(
    '[security] TOKEN_ENCRYPTION_KEY missing — using ephemeral dev key (encrypted tokens invalid after restart)'
  )
  cachedKey = crypto.scryptSync('listjetgo-dev-token-key', 'etsy-token-salt', 32)
  return cachedKey
}

export function validateTokenEncryptionKeyAtStartup(): void {
  try {
    getEncryptionKey()
  } catch (error) {
    console.error('[security] Startup failed:', error instanceof Error ? error.message : String(error))
    throw error
  }
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`
}

export function decryptToken(payload: string): string {
  const key = getEncryptionKey()
  const [ivB64, tagB64, dataB64] = payload.split('.')
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid encrypted token payload')
  }

  const iv = Buffer.from(ivB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  const data = Buffer.from(dataB64, 'base64url')
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
