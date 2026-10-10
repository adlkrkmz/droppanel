import { sendTelegramAlert } from "../notifications/telegramService"
import type { ZeroStockAlertEvent } from "./zeroStockAnomalyDetector"

export type ZeroStockTelegramSender = (message: string) => Promise<void>

/** Transport only: detector thresholds, cooldowns, and dedupe remain upstream. */
export async function deliverZeroStockTelegramAlert(
  event: ZeroStockAlertEvent,
  sender: ZeroStockTelegramSender = sendTelegramAlert,
): Promise<void> {
  try {
    await sender(event.message)
  } catch (error) {
    // A notification outage must never stop future detector cycles or affect mutations.
    console.error("[ZeroStockAnomaly] Telegram delivery failed", error instanceof Error ? error.message : String(error))
  }
}
