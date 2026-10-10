import { sortMonitorItems } from "../modules/monitor/monitorListingsQuery.ts"

const items = [
  { sku: "a", totalSold: 4, watchCount: 2, title: "a" },
  { sku: "b", totalSold: 49, watchCount: 30, title: "b" },
  { sku: "c", totalSold: "11", watchCount: null, views30d: 5, title: "c" },
  { sku: "d", totalSold: null, watchCount: 8, title: "d" },
  { sku: "e", totalSold: 6, watchCount: 0, title: "e" },
]

const soldDesc = sortMonitorItems(items, "totalSold", "desc")
console.log("totalSold desc:", soldDesc.map(i => i.totalSold))

const watchDesc = sortMonitorItems(items, "watchOrViews", "desc")
console.log("watchOrViews desc:", watchDesc.map(i => ({ w: i.watchCount, v: i.views30d })))
