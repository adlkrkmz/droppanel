import { redirect } from "next/navigation"

/** eBay panel entry — existing ops live at root routes (/pool, /scan, …). */
export default function EbayDashboardPage() {
  redirect("/pool")
}
