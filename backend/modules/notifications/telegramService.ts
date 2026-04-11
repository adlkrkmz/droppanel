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
    `🔥 <b>Worker Crash</b>\n${error.slice(0, 300)}`
  )
}

export async function alertTokenExpiring(storeCode: string): Promise<void> {
  await sendTelegramAlert(
    `⚠️ <b>eBay Token Süresi Doluyor</b>\nMağaza: ${storeCode}`
  )
}
