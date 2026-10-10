import { fetchProofImage } from "../mailbox/deliveryProofStore"

export type DeliveryPhotoMedia = {
  mediaName: string
  mediaType: "IMAGE"
  mediaUrl: string
  sourceContentType: string
  sourceBytes: number
}

type EbayImageUploader = {
  uploadImage(buffer: Buffer, fileName: string, contentType?: string): Promise<string>
}

export async function prepareDeliveryPhotoMedia(
  client: EbayImageUploader,
  sourceUrl: string
): Promise<
  | { ok: true; media: DeliveryPhotoMedia }
  | { ok: false; reason: string; sourceContentType: string | null }
> {
  const fetched = await fetchProofImage(sourceUrl)
  if ("reason" in fetched) {
    return { ok: false, reason: fetched.reason, sourceContentType: fetched.contentType ?? null }
  }

  const fileName = `delivery-photo.${fetched.ext}`
  try {
    const epsUrl = (await client.uploadImage(fetched.buffer, fileName, fetched.contentType)).trim()
    if (!isEbayPictureUrl(epsUrl)) {
      return { ok: false, reason: "eps_invalid_url", sourceContentType: fetched.contentType }
    }
    return {
      ok: true,
      media: {
        mediaName: fileName,
        mediaType: "IMAGE",
        mediaUrl: epsUrl,
        sourceContentType: fetched.contentType,
        sourceBytes: fetched.buffer.length,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason: `eps_upload_failed:${safeFailureCode(message)}`,
      sourceContentType: fetched.contentType,
    }
  }
}

function isEbayPictureUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && /(^|\.)ebayimg\.com$/i.test(url.hostname)
  } catch {
    return false
  }
}

function safeFailureCode(message: string): string {
  const http = message.match(/HTTP\s+(\d{3})/i)?.[1]
  if (http) return `http_${http}`
  if (/missing imageUrl/i.test(message)) return "missing_image_url"
  return "request_failed"
}
