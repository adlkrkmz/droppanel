import assert from "node:assert/strict"
import { getDashboardTodayRange, isInDashboardToday } from "../modules/app/dashboardBusinessDay"

function at(value: string): Date { return new Date(value) }
function iso(value: Date): string { return value.toISOString() }
function check(now: string, expectedStart: string): void {
  assert.equal(iso(getDashboardTodayRange(at(now)).start), expectedStart, now)
}

// Turkey is UTC+03:00; each input is an unambiguous UTC instant.
check("2026-10-05T06:58:00.000Z", "2026-10-04T07:00:00.000Z") // 09:58 TR
check("2026-10-05T06:59:59.000Z", "2026-10-04T07:00:00.000Z") // 09:59:59 TR
check("2026-10-05T07:00:00.000Z", "2026-10-05T07:00:00.000Z") // 10:00:00 TR
check("2026-10-05T07:00:01.000Z", "2026-10-05T07:00:00.000Z") // 10:00:01 TR
check("2026-10-05T20:59:00.000Z", "2026-10-05T07:00:00.000Z") // 23:59 TR
check("2026-10-04T21:30:00.000Z", "2026-10-04T07:00:00.000Z") // 00:30 TR
check("2026-10-05T06:59:00.000Z", "2026-10-04T07:00:00.000Z") // next-morning 09:59 TR

const beforeCutoff = getDashboardTodayRange(at("2026-10-05T06:59:00.000Z"))
const afterCutoff = getDashboardTodayRange(at("2026-10-05T07:00:00.000Z"))
const eventAt0958 = at("2026-10-05T06:58:00.000Z")
assert.equal(isInDashboardToday(eventAt0958, beforeCutoff), true)
assert.equal(isInDashboardToday(eventAt0958, afterCutoff), false)
console.log("PASS dashboard business-day cutoff fixtures (9/9)")
