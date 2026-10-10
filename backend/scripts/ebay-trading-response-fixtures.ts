import assert from "node:assert/strict"
import { classifyEbayTradingResponse } from "../modules/ebay/ebayApiClient"

const success = "<e:ReviseFixedPriceItemResponse xmlns:e=\"urn:ebay:apis:eBLBaseComponents\"><e:Ack>Success</e:Ack></e:ReviseFixedPriceItemResponse>"
const warning = "<e:ReviseFixedPriceItemResponse xmlns:e=\"urn:ebay:apis:eBLBaseComponents\"><e:Ack>Warning</e:Ack><e:Errors><e:Error><e:ErrorCode>100</e:ErrorCode><e:SeverityCode>Warning</e:SeverityCode><e:ShortMessage>Heads &amp; shoulders</e:ShortMessage></e:Error></e:Errors></e:ReviseFixedPriceItemResponse>"
const failure = "<e:ReviseFixedPriceItemResponse xmlns:e=\"urn:ebay:apis:eBLBaseComponents\"><e:Ack>Failure</e:Ack><e:Errors><e:Error><e:ErrorCode>21919188</e:ErrorCode><e:SeverityCode>Error</e:SeverityCode><e:ErrorClassification>RequestError</e:ErrorClassification><e:ShortMessage>Cannot revise listing</e:ShortMessage><e:LongMessage>Inventory item must use Inventory API</e:LongMessage><e:ErrorParameters><e:ErrorParameter><e:ParamID>ItemID</e:ParamID><e:Value>366142069801</e:Value></e:ErrorParameter></e:ErrorParameters></e:Error><e:Error><e:ErrorCode>25002</e:ErrorCode><e:SeverityCode>Warning</e:SeverityCode><e:ShortMessage>Secondary warning</e:ShortMessage></e:Error></e:Errors></e:ReviseFixedPriceItemResponse>",

const ok = classifyEbayTradingResponse(success)
assert.equal(ok.accepted, true)
assert.deepEqual(ok.errors, [])

const warned = classifyEbayTradingResponse(warning)
assert.equal(warned.accepted, true)
assert.equal(warned.warnings.length, 1)
assert.equal(warned.warnings[0].shortMessage, "Heads & shoulders")

const failed = classifyEbayTradingResponse(failure)
assert.equal(failed.accepted, false)
assert.equal(failed.errors.length, 1)
assert.equal(failed.warnings.length, 1)
assert.deepEqual(failed.errors[0].parameters, [{ name: "ItemID", value: "366142069801" }])
assert.equal(failed.errors[0].code, "21919188")

console.log("PASS eBay Trading parser: Success, Warning, Failure, namespaced multi-Errors and ErrorParameters")
