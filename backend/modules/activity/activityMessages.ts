export function formatStockZeroMessage(input: {
  asin: string
  oldQty: number
  confirmation?: "KEEPA_CONFIRMED" | "EXTENSION_VERIFIED" | "DESKTOP_AGENT" | "SERVER_BROWSER_PUBLIC" | "SERVER_BROWSER_AUTH"
}): { title: string; message: string } {
  const source =
    input.confirmation === "KEEPA_CONFIRMED"
      ? "Keepa confirmed"
      : input.confirmation === "DESKTOP_AGENT"
        ? "Desktop Agent verified"
        : input.confirmation === "SERVER_BROWSER_AUTH"
          ? "Server login worker verified"
          : input.confirmation === "SERVER_BROWSER_PUBLIC"
            ? "Server worker verified"
        : "Extension verified"
  return {
    title: "STOCK PROTECTION",
    message: `ASIN ${input.asin}\nAmazon'da geçerli Prime/FBA kaynak bulunamadı.\n\neBay stoğu:\n${input.oldQty} → 0\n\nSource: ${source}\nStock Guard`,
  }
}

export function formatPriceIncreaseMessage(input: {
  asin: string
  before: number
  after: number
}): { title: string; message: string } {
  return {
    title: "PRICE INCREASE",
    message: `ASIN ${input.asin}\n\nAmazon maliyeti:\n$${input.before.toFixed(2)} → $${input.after.toFixed(2)}\n\nDoğrulama tamamlandı.`,
  }
}

export function formatProfitProtectionMessage(input: {
  asin: string
  amazonBefore: number
  amazonAfter: number
  ebayBefore: number
  ebayAfter: number
  confirmation?: "KEEPA_CONFIRMED" | "EXTENSION_VERIFIED" | "DESKTOP_AGENT" | "SERVER_BROWSER_PUBLIC" | "SERVER_BROWSER_AUTH"
}): { title: string; message: string } {
  const source =
    input.confirmation === "KEEPA_CONFIRMED"
      ? "Keepa confirmed"
      : input.confirmation === "DESKTOP_AGENT"
        ? "Desktop Agent verified"
        : "Extension verified"
  return {
    title: "PROFIT PROTECTION",
    message:
      `ASIN ${input.asin}\n\nAmazon:\n$${input.amazonBefore.toFixed(2)} → $${input.amazonAfter.toFixed(2)}\n\neBay:\n$${input.ebayBefore.toFixed(2)} → $${input.ebayAfter.toFixed(2)}\n\nSource: ${source}\nKâr Koruma uygulandı.`,
  }
}

export function formatSourceRestoredMessage(input: { asin: string }): { title: string; message: string } {
  return {
    title: "SOURCE RESTORED",
    message: `ASIN ${input.asin}\n\nAmazon kaynağı tekrar bulundu. eBay stoğu otomatik artırılmadı.`,
  }
}

export function formatSourceVerifiedMessage(input: { asin: string; price: number | null }): { title: string; message: string } {
  const price = input.price != null ? `$${input.price.toFixed(2)}` : "—"
  return {
    title: "SOURCE VERIFIED",
    message: `ASIN ${input.asin}\n\nPrime / FBA doğrulandı.\n\n${price}\n\nİşlem gerekmedi.`,
  }
}
