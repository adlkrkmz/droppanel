import { query } from "../../db/client"
import { sendTelegramAlert } from "../notifications/telegramService"
import { capacitySeverity } from "./globalKeepaCapacity"

const ALERT_COOLDOWN_HOURS = 12

export async function maybeEmitCapacityAlert(input: {
  severity: ReturnType<typeof capacitySeverity>
  slaStatus: string
  utilizationPercent: number | null
  message: string
}): Promise<{ emitted: boolean }> {
  if (input.severity !== "WARNING" && input.severity !== "CRITICAL") {
    return { emitted: false }
  }
  const last = await query<{ severity: string; created_at: Date }>(
    `SELECT severity, created_at
     FROM keepa_platform_capacity_alerts
     WHERE severity = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [input.severity]
  )
  const prev = last.rows[0]
  if (prev) {
    const ageH = (Date.now() - new Date(prev.created_at).getTime()) / 3600_000
    if (ageH < ALERT_COOLDOWN_HOURS) return { emitted: false }
  }
  await query(
    `INSERT INTO keepa_platform_capacity_alerts (severity, sla_status, utilization_percent, message, created_at)
     VALUES ($1,$2,$3,$4,NOW())`,
    [input.severity, input.slaStatus, input.utilizationPercent, input.message]
  )
  await sendTelegramAlert(
    `📦 <b>Keepa platform capacity ${input.severity}</b>\n${input.message.slice(0, 400)}`
  )
  return { emitted: true }
}
