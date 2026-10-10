import assert from "assert"
import fs from "fs"
import path from "path"
import { randomUUID } from "crypto"
import "dotenv/config"
import { acquireClient } from "../db/client"
import { withFixtureBoundQuery } from "./bindFixtureQueryClient"
import { classifyMailboxEmail } from "../modules/mailbox/emailClassify"
import {
  parseAmazonDelayedEmail,
  parseAmazonDeliveredEmail,
  parseAmazonOrderedEmail,
  parseAmazonShippedEmail,
} from "../modules/mailbox/amazonEmailParser"
import {
  parseEbayCancelRequestEmail,
  parseEbayPayoutEmail,
  parseEbayReturnRequestEmail,
  parseEbaySaleEmail,
} from "../modules/mailbox/ebayEmailParser"
import { orderProfitFromRemainingAndCost } from "../modules/mailbox/mailboxTypes"
import { scoreAmazonCandidate, matchAmazonParseToEbayOrder } from "../modules/mailbox/orderMatchService"
import { applyAmazonParseToOrder } from "../modules/mailbox/mailboxApplyService"
import { processStoredMailboxMessage } from "../modules/mailbox/mailboxProcessService"
import { getStoreFinanceSummary } from "../modules/mailbox/storeFinanceSummary"
import { encryptMailboxTokens } from "../modules/mailbox/gmailClient"
import { GMAIL_WHITELIST_QUERY } from "../modules/mailbox/gmailClient"
import { runMailboxAccountBatch } from "../modules/mailbox/mailboxIngestService"

const AMZ = "111-2222222-3333333"
const AMZ_B = "222-3333333-4444444"
const ASIN = "B00SANIT12"
const EBAY_OID = "12-34567-89012"
const TRACK =
  "https://www.amazon.com/progress-tracker/package?orderId=111-2222222-3333333&packageIndex=0&shipmentId=DsNotCarrier"

const amazonOrdered = `
Hi Alex,
Arriving Tuesday, Oct 1
Delivering to Alex in Austin, TX
Amazon Order # ${AMZ}
Grand Total: $42.99
https://www.amazon.com/gp/your-account/order-details?orderID=${AMZ}
`

const amazonShipped = `
Your package is on the way
Arriving Wednesday
Delivering to Alex in Austin, TX
Amazon Order # ${AMZ}
Total: $42.99
Track package ${TRACK}
https://www.amazon.com/gp/your-account/order-details?orderID=${AMZ}
invoice https://www.amazon.com/gp/css/invoice.html
`

const amazonDelayed = `
Your package is delayed
now arriving Friday, Oct 4
Amazon Order # ${AMZ}
Track package ${TRACK}
Qty: 1
$12.50
Sanitized Widget Title Extra
https://www.amazon.com/dp/${ASIN}
Delivering to Alex in Austin, TX
`

const amazonDelivered = `
your package was delivered
Delivered today
left near front door or porch
Delivering to Alex in Austin, TX
Amazon Order # ${AMZ}
Track package ${TRACK}
`

const ebaySale = `
Congratulations, you sold an item
eBay order number: ${EBAY_OID}
sold for: $55.00
date sold: Sep 1, 2026
buyer username: buyer_sanitized
quantity: 1
ship by: Sep 3, 2026
item: Sanitized listing title
ship to: Alex Buyer, 100 Test St, Austin, TX 78701
`

const ebayCancel = `
The buyer requested to cancel an order
Order number: ${EBAY_OID}
buyer id: buyer_sanitized
cancel id: 5XXXXXXXX
respond by: Sep 5, 2026
item: Sanitized listing title
`

const ebayReturn = `
The buyer requested a return
Order number: ${EBAY_OID}
buyer id: buyer_sanitized
return id: 5YYYYYYYY
response deadline: Sep 8, 2026
item: Sanitized listing title
`

const ebayPayout = `
Your payout is on the way
total payout: $120.00
payout destination: Bank ****1111
payout type: Standard
payout date: Sep 10, 2026
payout id: 5PAYOUTID
estimated arrival: Sep 12, 2026
`

function destJson(city: string, state: string) {
  return {
    fulfillmentStartInstructions: [
      {
        shippingStep: {
          shipTo: { contactAddress: { city, stateOrProvince: state } },
        },
      },
    ],
  }
}

async function main(): Promise<void> {
  const mig = fs.readFileSync(
    path.join(__dirname, "../migrations/083_store_mailbox_email_foundation.sql"),
    "utf8"
  )
  assert.match(mig, /mailbox_accounts/)
  assert.match(mig, /UNIQUE \(mailbox_account_id, provider_message_id\)/)
  assert.match(mig, /amazon_cost_source/)
  const workspaceMig = fs.readFileSync(
    path.join(__dirname, "../migrations/089_workspace_mailboxes.sql"),
    "utf8"
  )
  assert.match(workspaceMig, /mailbox_accounts[\s\S]*store_id DROP NOT NULL/)
  assert.match(workspaceMig, /mailbox_messages[\s\S]*store_id DROP NOT NULL/)
  assert.match(workspaceMig, /workspace_id, provider, provider_account_id/)
  assert.doesNotMatch(workspaceMig, /DELETE FROM|DROP TABLE|TRUNCATE/i)
  assert.match(GMAIL_WHITELIST_QUERY, /newer_than:7d/)

  {
    const p = parseAmazonOrderedEmail(amazonOrdered)
    assert.equal(p.amazonOrderNumber, AMZ)
    assert.equal(p.recipientLabel, "Alex")
    assert.equal(p.destinationCity, "Austin")
    assert.equal(p.destinationState, "TX")
    assert.ok(p.estimatedDelivery?.toLowerCase().includes("tuesday"))
    assert.equal(p.finalTotal?.amount, 42.99)
    assert.equal(p.finalTotal?.currency, "USD")
    assert.ok(p.amazonOrderUrl?.includes("order-details"))
  }
  console.log("PASS 1 Amazon Ordered parse")

  {
    const p = parseAmazonShippedEmail(amazonShipped)
    assert.equal(p.amazonOrderNumber, AMZ)
    assert.equal(p.shipmentStatus, "SHIPPED")
    assert.equal(p.trackingUrl, TRACK)
    assert.equal(p.trackParts?.shipmentId, "DsNotCarrier")
    assert.equal(p.trackParts?.packageIndex, "0")
    assert.equal(p.trackParts?.orderId, AMZ)
    assert.equal(p.finalTotal?.amount, 42.99)
    assert.ok(p.trackParts?.shipmentId !== p.amazonOrderNumber)
  }
  console.log("PASS 2 Amazon Shipped parse")

  {
    const p = parseAmazonDelayedEmail(amazonDelayed)
    assert.equal(p.amazonOrderNumber, AMZ)
    assert.equal(p.asin, ASIN)
    assert.equal(p.quantity, 1)
    assert.equal(p.displayedItemPrice?.amount, 12.5)
    assert.ok(p.trackingUrl)
    assert.ok(p.productTitle)
  }
  console.log("PASS 3 Amazon Delayed parse + ASIN")

  {
    const p = parseAmazonDeliveredEmail(amazonDelivered)
    assert.match(p.deliveryLocationText ?? "", /front door|porch/i)
    assert.equal(p.deliveredDateText, "today")
    assert.equal(p.shipmentStatus, "DELIVERED")
    assert.equal(p.amazonOrderNumber, AMZ)
  }
  console.log("PASS 4 Amazon Delivered + delivery location")

  {
    const p = parseEbaySaleEmail(ebaySale)
    assert.equal(p.ebayOrderId, EBAY_OID)
    assert.equal(p.soldAmount?.amount, 55)
    assert.equal(p.buyerUsername, "buyer_sanitized")
    assert.equal(p.quantity, 1)
    assert.ok(p.shipBy)
    assert.ok(p.itemTitle)
  }
  console.log("PASS 5 eBay Sale parse")

  {
    const p = parseEbayCancelRequestEmail(ebayCancel)
    assert.equal(p.ebayOrderId, EBAY_OID)
    assert.equal(p.cancelId, "5XXXXXXXX")
    assert.equal(p.buyerId, "buyer_sanitized")
  }
  console.log("PASS 6 eBay Cancel Request parse")

  {
    const p = parseEbayReturnRequestEmail(ebayReturn)
    assert.equal(p.ebayOrderId, EBAY_OID)
    assert.equal(p.returnId, "5YYYYYYYY")
  }
  console.log("PASS 7 eBay Return Request parse")

  {
    const p = parseEbayPayoutEmail(ebayPayout)
    assert.equal(p.payoutId, "5PAYOUTID")
    assert.equal(p.amount?.amount, 120)
    assert.ok(p.destination)
  }
  console.log("PASS 8 eBay Payout parse")

  assert.equal(
    classifyMailboxEmail({
      sender: "store-news@amazon.com",
      subject: "Lightning Deal on widgets",
      textBody: "Today's deals recommended for you",
    }),
    "IGNORED"
  )
  assert.equal(
    classifyMailboxEmail({
      sender: "ebay@ebay.com",
      subject: "Daily Deal — don't miss",
      textBody: "trending on ebay",
    }),
    "IGNORED"
  )
  assert.equal(
    classifyMailboxEmail({
      sender: "auto-confirm@amazon.com",
      subject: "Your Amazon Smile newsletter",
      textBody: "recommended for you",
    }),
    "IGNORED"
  )
  assert.equal(
    classifyMailboxEmail({
      sender: "shipment-tracking@amazon.com",
      subject: "Delivery update",
      textBody: amazonDelayed,
    }),
    "AMAZON_DELAYED"
  )
  console.log("PASS 10 unknown Amazon/eBay promotional mail ignored")

  {
    const none = orderProfitFromRemainingAndCost({
      ebayRemainingEarnings: 40,
      amazonFinalCost: null,
    })
    assert.equal(none.profit, null)
    assert.equal(none.profitPercent, null)
    const ok = orderProfitFromRemainingAndCost({
      ebayRemainingEarnings: 40,
      amazonFinalCost: 10,
    })
    assert.equal(ok.profit, 30)
    assert.equal(ok.profitPercent, 75)
  }
  console.log("PASS 13 NULL cost → no fake profit")

  {
    const weak = scoreAmazonCandidate({
      parsedAsin: ASIN,
      parsedCity: null,
      parsedState: null,
      parsedQty: null,
      candidateAsin: ASIN,
      candidateCity: "Austin",
      candidateState: "TX",
      candidateQty: 1,
    })
    assert.equal(weak.pass, false)
    const strong = scoreAmazonCandidate({
      parsedAsin: ASIN,
      parsedCity: "Austin",
      parsedState: "TX",
      parsedQty: 1,
      candidateAsin: ASIN,
      candidateCity: "Austin",
      candidateState: "TX",
      candidateQty: 1,
    })
    assert.equal(strong.pass, true)
  }

  const client = await acquireClient("mailbox-email-fixtures")
  try {
    await client.query("BEGIN")
    await client.query(workspaceMig)
    await withFixtureBoundQuery(client, async () => {
      const ws = randomUUID()
      await client.query(`INSERT INTO workspaces (id, name) VALUES ($1::uuid, $2)`, [
        ws,
        "__mailbox_phase1_tx__",
      ])
      const storeA = await client.query<{ id: number }>(
        `INSERT INTO stores (workspace_id, name, store_code, status)
         VALUES ($1::uuid, 'mb-a', $2, 'active') RETURNING id`,
        [ws, `mba-${ws.slice(0, 8)}`]
      )
      const storeB = await client.query<{ id: number }>(
        `INSERT INTO stores (workspace_id, name, store_code, status)
         VALUES ($1::uuid, 'mb-b', $2, 'active') RETURNING id`,
        [ws, `mbb-${ws.slice(0, 8)}`]
      )
      const sidA = Number(storeA.rows[0]!.id)
      const sidB = Number(storeB.rows[0]!.id)
      const codeA = `mba-${ws.slice(0, 8)}`
      const codeB = `mbb-${ws.slice(0, 8)}`

      const tokens = encryptMailboxTokens({
        accessToken: "fixture-access",
        refreshToken: "fixture-refresh",
        expiresAt: new Date(Date.now() + 3600_000),
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      })
      const accA = await client.query<{ id: number }>(
        `INSERT INTO mailbox_accounts (
           workspace_id, store_id, provider, email_address, provider_account_id,
           access_token_enc, refresh_token_enc, scope, status
         ) VALUES ($1::uuid, $2, 'gmail', 'a@example.com', $3, $4, $5, 'gmail.readonly', 'CONNECTED')
         RETURNING id`,
        [ws, sidA, `gacc-a-${ws}`, tokens.accessEnc, tokens.refreshEnc]
      )
      const accB = await client.query<{ id: number }>(
        `INSERT INTO mailbox_accounts (
           workspace_id, store_id, provider, email_address, provider_account_id,
           access_token_enc, refresh_token_enc, scope, status
         ) VALUES ($1::uuid, NULL, 'gmail', 'b@example.com', $2, $3, $4, 'gmail.readonly', 'CONNECTED')
         RETURNING id`,
        [ws, `gacc-b-${ws}`, tokens.accessEnc, tokens.refreshEnc]
      )
      const mailboxA = Number(accA.rows[0]!.id)

      const ins1 = await client.query<{ id: number }>(
        `INSERT INTO mailbox_messages (
           workspace_id, store_id, mailbox_account_id, provider_message_id, sender, subject,
           text_body, processing_status
         ) VALUES ($1::uuid, $2, $3, 'gmail-msg-dup', 'auto-confirm@amazon.com', 'Ordered 1 item', $4, 'PENDING')
         RETURNING id`,
        [ws, sidA, mailboxA, amazonOrdered]
      )
      const ins2 = await client.query<{ id: number }>(
        `INSERT INTO mailbox_messages (
           workspace_id, store_id, mailbox_account_id, provider_message_id, sender, subject,
           text_body, processing_status
         ) VALUES ($1::uuid, $2, $3, 'gmail-msg-dup', 'auto-confirm@amazon.com', 'Ordered 1 item', $4, 'PENDING')
         ON CONFLICT (mailbox_account_id, provider_message_id) DO NOTHING
         RETURNING id`,
        [ws, sidA, mailboxA, amazonOrdered]
      )
      assert.ok(ins1.rows[0]?.id)
      assert.equal(ins2.rows.length, 0)
      const firstId = Number(ins1.rows[0]!.id)
      const again = await processStoredMailboxMessage(firstId)
      assert.ok(again.status === "NEEDS_REVIEW" || again.status === "PROCESSED")
      const dupProcess = await processStoredMailboxMessage(firstId)
      assert.equal(dupProcess.status, again.status)
      assert.equal(dupProcess.type, null)
      console.log("PASS 9 duplicate Gmail message ignored")

      const orderA = await client.query<{ id: number }>(
        `INSERT INTO ebay_orders (
           workspace_id, store_id, store_code, ebay_order_id, total_amount, currency,
           ebay_order_earnings, order_created_at, amazon_order_number, raw_ebay_order_json
         ) VALUES (
           $1::uuid, $2, $3, $4, 55, 'USD', 40, NOW(), $5, $6::jsonb
         ) RETURNING id`,
        [ws, sidA, codeA, EBAY_OID, AMZ, JSON.stringify(destJson("Austin", "TX"))]
      )
      const pkA = Number(orderA.rows[0]!.id)
      await client.query(
        `INSERT INTO ebay_order_items (
           order_id, workspace_id, ebay_order_id, line_key, asin, quantity
         ) VALUES ($1, $2::uuid, $3, 'line-1', $4, 1)`,
        [pkA, ws, EBAY_OID, ASIN]
      )

      const orderB = await client.query<{ id: number }>(
        `INSERT INTO ebay_orders (
           workspace_id, store_id, store_code, ebay_order_id, total_amount, currency,
           ebay_order_earnings, order_created_at, amazon_order_number, raw_ebay_order_json
         ) VALUES (
           $1::uuid, $2, $3, '12-99999-00001', 99, 'USD', 80, NOW(), $4, $5::jsonb
         ) RETURNING id`,
        [ws, sidB, codeB, AMZ_B, JSON.stringify(destJson("Dallas", "TX"))]
      )
      const pkB = Number(orderB.rows[0]!.id)

      const cross = await matchAmazonParseToEbayOrder({
        workspaceId: ws,
        parsed: parseAmazonOrderedEmail(amazonOrdered),
        receivedAt: new Date(),
      })
      assert.equal(cross.ok, true)
      if (cross.ok) {
        assert.equal(cross.orderPk, pkA)
        assert.equal(cross.storeId, sidA)
      }
      const fromB = await matchAmazonParseToEbayOrder({
        workspaceId: ws,
        parsed: parseAmazonOrderedEmail(
          amazonOrdered.replace(AMZ, AMZ_B).replace("Austin", "Dallas").replace("$42.99", "$51.25")
        ),
        receivedAt: new Date(),
      })
      assert.equal(fromB.ok, true)
      if (fromB.ok) {
        assert.equal(fromB.orderPk, pkB)
        assert.equal(fromB.storeId, sidB)
      }
      console.log("PASS 11 one mailbox matches orders across stores and derives store")

      const mailboxB = Number(accB.rows[0]!.id)
      const sameMailboxA = await client.query<{ id: number }>(
        `INSERT INTO mailbox_messages (
           workspace_id, store_id, mailbox_account_id, provider_message_id, sender, subject,
           text_body, processing_status
         ) VALUES ($1::uuid, NULL, $2, 'workspace-mail-s1', 'auto-confirm@amazon.com',
           'Ordered 1 item', $3, 'PENDING') RETURNING id`,
        [ws, mailboxB, amazonOrdered]
      )
      const sameMailboxB = await client.query<{ id: number }>(
        `INSERT INTO mailbox_messages (
           workspace_id, store_id, mailbox_account_id, provider_message_id, sender, subject,
           text_body, processing_status
         ) VALUES ($1::uuid, NULL, $2, 'workspace-mail-s2', 'auto-confirm@amazon.com',
           'Ordered 1 item', $3, 'PENDING') RETURNING id`,
        [ws, mailboxB, amazonOrdered.replace(AMZ, AMZ_B).replace("Austin", "Dallas").replace("$42.99", "$51.25")]
      )
      assert.equal((await processStoredMailboxMessage(Number(sameMailboxA.rows[0]!.id))).status, "PROCESSED")
      assert.equal((await processStoredMailboxMessage(Number(sameMailboxB.rows[0]!.id))).status, "PROCESSED")
      const derived = await client.query<{ provider_message_id: string; store_id: number }>(
        `SELECT provider_message_id, store_id FROM mailbox_messages
         WHERE id = ANY($1::bigint[]) ORDER BY provider_message_id`,
        [[Number(sameMailboxA.rows[0]!.id), Number(sameMailboxB.rows[0]!.id)]]
      )
      assert.deepEqual(derived.rows.map(r => Number(r.store_id)).sort((a, b) => a - b), [sidA, sidB].sort((a, b) => a - b))
      console.log("PASS 16 mailbox without store assignment persists matched order stores")

      const secondMailboxMatch = await client.query<{ id: number }>(
        `INSERT INTO mailbox_messages (
           workspace_id, store_id, mailbox_account_id, provider_message_id, sender, subject,
           text_body, processing_status
         ) VALUES ($1::uuid, NULL, $2, 'second-mailbox-s1', 'auto-confirm@amazon.com',
           'Ordered 1 item', $3, 'PENDING') RETURNING id`,
        [ws, mailboxA, amazonOrdered]
      )
      assert.equal((await processStoredMailboxMessage(Number(secondMailboxMatch.rows[0]!.id))).status, "PROCESSED")
      console.log("PASS 17 multiple Gmail accounts match across workspace stores")

      const wsOther = randomUUID()
      await client.query(`INSERT INTO workspaces (id, name) VALUES ($1::uuid, 'mailbox-isolation')`, [wsOther])
      const otherStore = await client.query<{ id: number }>(
        `INSERT INTO stores (workspace_id, name, store_code, status)
         VALUES ($1::uuid, 'other', $2, 'active') RETURNING id`,
        [wsOther, `other-${wsOther.slice(0, 8)}`]
      )
      await client.query(
        `INSERT INTO ebay_orders (
           workspace_id, store_id, store_code, ebay_order_id, total_amount, currency,
           order_created_at, amazon_order_number, raw_ebay_order_json
         ) VALUES ($1::uuid, $2, $3, '12-00000-99999', 20, 'USD', NOW(), $4, $5::jsonb)`,
        [wsOther, Number(otherStore.rows[0]!.id), `other-${wsOther.slice(0, 8)}`, "333-4444444-5555555", JSON.stringify(destJson("Miami", "FL"))]
      )
      const isolated = await matchAmazonParseToEbayOrder({
        workspaceId: ws,
        parsed: parseAmazonOrderedEmail(amazonOrdered.replace(AMZ, "333-4444444-5555555").replace("Austin, TX", "Miami, FL")),
        receivedAt: new Date(),
      })
      assert.equal(isolated.ok, false)
      console.log("PASS 18 cross-workspace order cannot match")

      const noMatchMessage = await client.query<{ id: number }>(
        `INSERT INTO mailbox_messages (
           workspace_id, store_id, mailbox_account_id, provider_message_id, sender, subject,
           text_body, processing_status
         ) VALUES ($1::uuid, NULL, $2, 'no-reliable-match', 'auto-confirm@amazon.com',
           'Ordered 1 item', $3, 'PENDING') RETURNING id`,
        [ws, mailboxB, amazonOrdered.replace(AMZ, "999-8888888-7777777").replace("Austin, TX", "Nowhere, ZZ")]
      )
      assert.equal((await processStoredMailboxMessage(Number(noMatchMessage.rows[0]!.id))).status, "NEEDS_REVIEW")
      const noGuess = await client.query<{ store_id: number | null }>(
        `SELECT store_id FROM mailbox_messages WHERE id = $1`,
        [Number(noMatchMessage.rows[0]!.id)]
      )
      assert.equal(noGuess.rows[0]!.store_id, null)
      console.log("PASS 19 uncertain email stays NEEDS_REVIEW without guessed store")

      const legacy = await client.query<{ store_id: number; refresh_token_enc: string }>(
        `SELECT store_id, refresh_token_enc FROM mailbox_accounts WHERE id = $1`,
        [mailboxA]
      )
      assert.equal(Number(legacy.rows[0]!.store_id), sidA)
      assert.equal(legacy.rows[0]!.refresh_token_enc, tokens.refreshEnc)
      console.log("PASS 20 legacy mailbox and encrypted token preserved")

      const attempted: number[] = []
      await runMailboxAccountBatch([mailboxA, mailboxB], async id => {
        attempted.push(id)
        if (id === mailboxA) throw new Error("fixture account failure")
      })
      assert.deepEqual(attempted, [mailboxA, mailboxB])
      console.log("PASS 21 one mailbox failure does not block another")

      const delayedNoOrder = `
Your package is delayed
now arriving Friday, Oct 4
Qty: 1
$12.50
Sanitized Widget Title Extra
https://www.amazon.com/dp/${ASIN}
Delivering to Alex in Austin, TX
`
      const oid2 = "12-34567-89099"
      const oid3 = "12-34567-89100"
      const orderA2 = await client.query<{ id: number }>(
        `INSERT INTO ebay_orders (
           workspace_id, store_id, store_code, ebay_order_id, total_amount, currency,
           order_created_at, raw_ebay_order_json
         ) VALUES ($1::uuid, $2, $3, $4, 10, 'USD', NOW(), $5::jsonb) RETURNING id`,
        [ws, sidA, codeA, oid2, JSON.stringify(destJson("Austin", "TX"))]
      )
      const orderA3 = await client.query<{ id: number }>(
        `INSERT INTO ebay_orders (
           workspace_id, store_id, store_code, ebay_order_id, total_amount, currency,
           order_created_at, raw_ebay_order_json
         ) VALUES ($1::uuid, $2, $3, $4, 11, 'USD', NOW(), $5::jsonb) RETURNING id`,
        [ws, sidA, codeA, oid3, JSON.stringify(destJson("Austin", "TX"))]
      )
      const pkA2 = Number(orderA2.rows[0]!.id)
      const pkA3 = Number(orderA3.rows[0]!.id)
      await client.query(
        `INSERT INTO ebay_order_items (order_id, workspace_id, ebay_order_id, line_key, asin, quantity)
         VALUES ($1, $2::uuid, $3, 'line-1', $4, 1)`,
        [pkA2, ws, oid2, ASIN]
      )
      await client.query(
        `INSERT INTO ebay_order_items (order_id, workspace_id, ebay_order_id, line_key, asin, quantity)
         VALUES ($1, $2::uuid, $3, 'line-1', $4, 1)`,
        [pkA3, ws, oid3, ASIN]
      )
      const ambig = await matchAmazonParseToEbayOrder({
        workspaceId: ws,
        parsed: parseAmazonDelayedEmail(delayedNoOrder),
        receivedAt: new Date(),
      })
      assert.equal(ambig.ok, false)
      if (!ambig.ok) assert.equal(ambig.reason, "ambiguous")
      console.log("PASS 12 ambiguous source order → NEEDS_REVIEW")

      const applied = await applyAmazonParseToOrder({
        workspaceId: ws,
        storeId: sidA,
        orderPk: pkA,
        mailboxMessageId: firstId,
        parsed: parseAmazonOrderedEmail(amazonOrdered),
        receivedAt: new Date(),
      })
      assert.equal(applied.applied, true)
      const costRow = await client.query<{ amazon_purchase_price: string; amazon_cost_source: string }>(
        `SELECT amazon_purchase_price::text, amazon_cost_source FROM ebay_orders WHERE id = $1`,
        [pkA]
      )
      assert.equal(parseFloat(costRow.rows[0]!.amazon_purchase_price), 42.99)
      assert.equal(costRow.rows[0]!.amazon_cost_source, "EMAIL_GRAND_TOTAL")
      console.log("PASS 14 matched final Amazon Total → correct order purchase cost")

      await client.query(
        `INSERT INTO ebay_orders (
           workspace_id, store_id, store_code, ebay_order_id, total_amount, currency,
           ebay_order_earnings, amazon_purchase_price, order_created_at
         ) VALUES ($1::uuid, $2, $3, '12-11111-22222', 20, 'USD', 15, NULL, NOW())`,
        [ws, sidB, codeB]
      )
      const fa = await getStoreFinanceSummary(ws, sidA, codeA)
      const fb = await getStoreFinanceSummary(ws, sidB, codeB)
      assert.ok(fa.today.orderCount >= 1)
      assert.ok(fa.today.amazonCostKnownTotal > 0)
      assert.notEqual(fa.today.amazonCostKnownTotal, fb.today.amazonCostKnownTotal)
      assert.ok(fa.today.costKnownCount <= fa.today.costTotalCount)
      assert.ok(fb.today.costKnownCount < fb.today.costTotalCount || fb.today.costTotalCount === 0)
      console.log("PASS 15 dashboard store isolation")

      const promo = await client.query<{ id: number }>(
        `INSERT INTO mailbox_messages (
           workspace_id, store_id, mailbox_account_id, provider_message_id, sender, subject,
           text_body, processing_status
         ) VALUES ($1::uuid, $2, $3, 'gmail-promo', 'deals@amazon.com', 'Lightning Deal inside',
           'Today''s deals recommended for you', 'PENDING') RETURNING id`,
        [ws, sidA, mailboxA]
      )
      const promoRes = await processStoredMailboxMessage(Number(promo.rows[0]!.id))
      assert.equal(promoRes.status, "IGNORED")

      const unknown = await client.query<{ id: number }>(
        `INSERT INTO mailbox_messages (
           workspace_id, store_id, mailbox_account_id, provider_message_id, sender, subject,
           text_body, processing_status
         ) VALUES ($1::uuid, $2, $3, 'gmail-unk', 'auto-confirm@amazon.com', 'About your Amazon account',
           'Please review account settings', 'PENDING') RETURNING id`,
        [ws, sidA, mailboxA]
      )
      const unkRes = await processStoredMailboxMessage(Number(unknown.rows[0]!.id))
      assert.equal(unkRes.status, "NEEDS_REVIEW")
    })
  } finally {
    await client.query("ROLLBACK").catch(() => undefined)
    client.release()
  }
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
