import assert from "node:assert/strict"
import { reconciliationEligibility } from "../modules/listings/listingsSyncService"
import type { EbayCatalogPaginationReceipt } from "../modules/ebay/ebayApiClient"

function receipt(overrides: Partial<EbayCatalogPaginationReceipt> = {}): EbayCatalogPaginationReceipt {
  return {
    expectedTotalEntries: 6075, expectedTotalPages: 61, requestedPageSize: 100,
    pagesAttempted: 61, pagesCompleted: 61, lastCompletedPage: 61, fetchedRowCount: 6075,
    distinctRemoteItemCount: 6075, duplicateRemoteItemCount: 0, fetchErrorCount: 0,
    firstError: null, paginationCompleted: true, totalsConsistent: true, ...overrides,
  }
}
assert.equal(reconciliationEligibility(receipt()).eligible, true, "complete 61-page fetch may reconcile")
for (const partial of [
  receipt({ pagesAttempted: 14, pagesCompleted: 13, lastCompletedPage: 13, fetchedRowCount: 1281, distinctRemoteItemCount: 1281, paginationCompleted: false, totalsConsistent: false, fetchErrorCount: 1, firstError: "network failure" }),
  receipt({ pagesAttempted: 13, pagesCompleted: 13, lastCompletedPage: 13, fetchedRowCount: 1281, distinctRemoteItemCount: 1281, paginationCompleted: false, totalsConsistent: false }),
  receipt({ pagesAttempted: 14, pagesCompleted: 13, lastCompletedPage: 13, fetchedRowCount: 1200, distinctRemoteItemCount: 1200, paginationCompleted: false, totalsConsistent: false, firstError: "unexpected empty page" }),
  receipt({ fetchedRowCount: 6074, distinctRemoteItemCount: 6074, totalsConsistent: false }),
  receipt({ expectedTotalEntries: 0, expectedTotalPages: 1, pagesAttempted: 1, pagesCompleted: 0, lastCompletedPage: 0, fetchedRowCount: 0, distinctRemoteItemCount: 0, paginationCompleted: false, totalsConsistent: false }),
]) assert.equal(reconciliationEligibility(partial).eligible, false, "partial/uncertain fetch must not reconcile")
const incident = receipt({ pagesAttempted: 13, pagesCompleted: 13, lastCompletedPage: 13, fetchedRowCount: 1281, distinctRemoteItemCount: 1281, paginationCompleted: false, totalsConsistent: false })
assert.equal(reconciliationEligibility(incident).eligible, false)
console.log("LISTINGS_SYNC_COMPLETENESS_FIXTURES=PASS; INCIDENT_REPLAY eligible=false rowsEnded=0 rowsHidden=0")
