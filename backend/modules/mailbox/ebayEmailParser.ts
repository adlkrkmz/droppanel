import { EBAY_ORDER_NUMBER_RE, type EbayCancelParse, type EbayCancelledParse, type EbayPayoutParse, type EbayReturnParse, type EbaySaleParse } from "./mailboxTypes"
import { parseMoney } from "./amazonEmailParser"

function ebayOrderId(text: string): string | null {
  const labeled =
    text.match(/eBay order number[:\s]+([0-9-]+)/i)
    ?? text.match(/Order number[:\s]+([0-9-]+)/i)
  if (labeled?.[1] && EBAY_ORDER_NUMBER_RE.test(labeled[1])) return labeled[1]
  return text.match(EBAY_ORDER_NUMBER_RE)?.[1] ?? null
}

export function parseEbaySaleEmail(text: string): EbaySaleParse {
  const soldLine =
    text.match(/sold (?:for|amount)[:\s]+([^\n]+)/i)
    ?? text.match(/US\s*\$[0-9,]+\.[0-9]{2}/)
  const qty = text.match(/quantity[:\s]+(\d+)/i)
  const buyer = text.match(/buyer(?: username)?[:\s]+([A-Za-z0-9._-]+)/i)
  const shipBy = text.match(/ship by[:\s]+([^\n]+)/i)
  const dateSold = text.match(/date sold[:\s]+([^\n]+)/i) ?? text.match(/sold on[:\s]+([^\n]+)/i)
  const item = text.match(/item[:\s]+([^\n]+)/i)
  const shipName = text.match(/ship to[:\s]+([^\n]+)/i)
  return {
    type: "EBAY_SALE",
    ebayOrderId: ebayOrderId(text),
    soldAmount: soldLine ? parseMoney(soldLine[1] ?? soldLine[0]) : parseMoney(text),
    dateSold: dateSold?.[1]?.trim() || null,
    buyerUsername: buyer?.[1] ?? null,
    quantity: qty ? parseInt(qty[1]!, 10) || null : null,
    shipBy: shipBy?.[1]?.trim() || null,
    itemTitle: item?.[1]?.trim() || null,
    shippingRecipient: shipName?.[1]?.split(",")[0]?.trim() || null,
    shippingAddress: shipName?.[1]?.trim() || null,
  }
}

export function parseEbayCancelRequestEmail(text: string): EbayCancelParse {
  const buyer = text.match(/buyer id[:\s]+([A-Za-z0-9._-]+)/i)
  const cancel = text.match(/cancel id[:\s]+([A-Za-z0-9-]+)/i)
  const deadline = text.match(/(?:respond by|response deadline)[:\s]+([^\n]+)/i)
  const item = text.match(/item[:\s]+([^\n]+)/i)
  return {
    type: "EBAY_CANCEL_REQUEST",
    ebayOrderId: ebayOrderId(text),
    buyerId: buyer?.[1] ?? null,
    cancelId: cancel?.[1] ?? null,
    responseDeadline: deadline?.[1]?.trim() || null,
    itemTitle: item?.[1]?.trim() || null,
  }
}

export function parseEbayCancelledEmail(text: string): EbayCancelledParse {
  const cancel = text.match(/cancel id[:\s]+([A-Za-z0-9-]+)/i)
  const item = text.match(/item[:\s]+([^\n]+)/i)
  return {
    type: "EBAY_CANCELLED",
    ebayOrderId: ebayOrderId(text),
    cancelId: cancel?.[1] ?? null,
    itemTitle: item?.[1]?.trim() || null,
  }
}

export function parseEbayReturnRequestEmail(text: string): EbayReturnParse {
  const buyer = text.match(/buyer id[:\s]+([A-Za-z0-9._-]+)/i)
  const ret = text.match(/return id[:\s]+([A-Za-z0-9-]+)/i)
  const deadline = text.match(/(?:respond by|response deadline|next step)[:\s]+([^\n]+)/i)
  const item = text.match(/item[:\s]+([^\n]+)/i)
  return {
    type: "EBAY_RETURN_REQUEST",
    ebayOrderId: ebayOrderId(text),
    buyerId: buyer?.[1] ?? null,
    returnId: ret?.[1] ?? null,
    responseDeadline: deadline?.[1]?.trim() || null,
    itemTitle: item?.[1]?.trim() || null,
  }
}

export function parseEbayPayoutEmail(text: string): EbayPayoutParse {
  const amountLine =
    text.match(/payout amount[:\s]+([^\n]+)/i)
    ?? text.match(/total payout[:\s]+([^\n]+)/i)
  const id = text.match(/payout id[:\s]+([A-Za-z0-9-]+)/i)
  const dest = text.match(/(?:payout destination|bank account|destination)[:\s]+([^\n]+)/i)
  const typ = text.match(/payout type[:\s]+([^\n]+)/i)
  const date = text.match(/(?:payout date|date)[:\s]+([^\n]+)/i)
  const eta = text.match(/estimated arrival[:\s]+([^\n]+)/i)
  return {
    type: "EBAY_PAYOUT",
    payoutId: id?.[1] ?? null,
    amount: amountLine ? parseMoney(amountLine[1]!) : null,
    destination: dest?.[1]?.trim() || null,
    payoutType: typ?.[1]?.trim() || null,
    payoutDate: date?.[1]?.trim() || null,
    estimatedArrival: eta?.[1]?.trim() || null,
  }
}
