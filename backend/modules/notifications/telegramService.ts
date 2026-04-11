import fetch from "node-fetch"

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID = process.env.TELEGRAM_CHAT_ID

export async function sendTelegramAlert(message: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    })
  } catch (e) {
    console.error("[Telegram] Alert gönderilemedi:", e)
  }
}

export async function alertPublishFailed(asin: string, error: string): Promise<void> {
  await sendTelegramAlert(
    `❌ <b>Publish Başarısız</b>\nASIN: <code>${asin}</code>\nHata: ${error.slice(0, 200)}`
  )
}

export async function alertWorkerCrash(error: string): Promise<void> {
  await sendTelegramAlert(
    `🔥 <b>Worker Crash!</b>\nSistem durdu, müdahale gerekli!\nHata: ${error.slice(0, 300)}`
  )
}

export async function alertTokenExpiring(storeCode: string, expiresIn: string): Promise<void> {
  await sendTelegramAlert(
    `⚠️ <b>eBay Token Süresi Doluyor</b>\nMağaza: <code>${storeCode}</code>\nKalan süre: ${expiresIn}`
  )
}

export async function alertTokenRefreshFailed(storeCode: string, error: string): Promise<void> {
  await sendTelegramAlert(
    `❌ <b>eBay Token Yenileme Başarısız!</b>\nMağaza: <code>${storeCode}</code>\nHata: ${error.slice(0, 200)}`
  )
}

export async function alertQueueStuck(pendingCount: number, minutesStuck: number): Promise<void> {
  await sendTelegramAlert(
    `🚨 <b>Queue Takıldı!</b>\n${pendingCount} job ${minutesStuck} dakikadır işlenmiyor.\nWorker çalışıyor mu kontrol et!`
  )
}

export async function alertRateLimit(service: string, error: string): Promise<void> {
  await sendTelegramAlert(
    `🚫 <b>Rate Limit / API Block</b>\nServis: <code>${service}</code>\nHata: ${error.slice(0, 200)}`
  )
}

export async function alertHealthCheckFailed(service: string, error: string): Promise<void> {
  await sendTelegramAlert(
    `🏥 <b>Health Check Başarısız!</b>\nServis: <code>${service}</code>\nHata: ${error.slice(0, 200)}\nSistemi kontrol et!`
  )
}

export async function alertBackupFailed(error: string): Promise<void> {
  await sendTelegramAlert(
    `💾 <b>Backup Başarısız!</b>\nVeritabanı yedeği alınamadı!\nHata: ${error.slice(0, 200)}`
  )
}

export async function alertScraperFailSpike(failCount: number, totalCount: number): Promise<void> {
  await sendTelegramAlert(
    `🕷️ <b>Scraper Fail Spike!</b>\nSon ${totalCount} job'un ${failCount} tanesi başarısız!\nScraper'ı kontrol et.`
  )
}
