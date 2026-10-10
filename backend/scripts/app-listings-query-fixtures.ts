import { listingsSearchWhereClause } from "../modules/app/appListingFilters"

function maxPlaceholder(sql: string): number {
  return [...sql.matchAll(/\$(\d+)/g)].reduce((max, match) => Math.max(max, Number(match[1])), 0)
}

const baseWhere = "WHERE scs.workspace_id = $1 AND s.store_code = $2"
const cases = ["", "s", "178047714731", "B000000000", "Cable %_ adapter's"]

for (const value of cases) {
  const search = listingsSearchWhereClause(value)
  if (value && !/ebay_item_id/.test(search.sql) || value && !/internal_sku/.test(search.sql) || value && !/source_url/.test(search.sql) || value && !/ebay_title/.test(search.sql)) {
    throw new Error(`Search fields missing for ${JSON.stringify(value)}`)
  }
  const countSql = `${baseWhere}${search.sql}`
  const selectSql = `${baseWhere}${search.sql} LIMIT ${search.value ? "$4" : "$3"} OFFSET ${search.value ? "$5" : "$4"}`
  const countParams = search.value ? ["workspace", "store", search.value] : ["workspace", "store"]
  const selectParams = search.value
    ? ["workspace", "store", search.value, 50, 0]
    : ["workspace", "store", 50, 0]

  if (maxPlaceholder(countSql) !== countParams.length) throw new Error(`COUNT mismatch for ${JSON.stringify(value)}`)
  if (maxPlaceholder(selectSql) !== selectParams.length) throw new Error(`SELECT mismatch for ${JSON.stringify(value)}`)
}

const asinFallback = listingsSearchWhereClause("B09TV5SHFD")
if (!asinFallback.sql.includes("internal_sku") || !asinFallback.sql.includes("source_url")) {
  throw new Error("Displayed ASIN fallback search fixture failed")
}

console.log("PASS app listings search placeholder fixtures")
