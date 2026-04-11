import dotenv from 'dotenv'
dotenv.config()
import { sendTelegramAlert } from '../modules/notifications/telegramService'

async function main() {
  await sendTelegramAlert('✅ <b>DropPanel Alert Test</b>\nSistem çalışıyor!')
  console.log('Mesaj gönderildi')
}

main().catch(console.error)
