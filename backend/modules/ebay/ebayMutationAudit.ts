export type EbayMutationKind = "quantity" | "price" | "end" | "publish"

export type EbayMutationOutcome = "real" | "blocked" | "simulated"

type Counts = Record<EbayMutationKind, number>

function emptyCounts(): Counts {
  return { quantity: 0, price: 0, end: 0, publish: 0 }
}

const audit = {
  real: emptyCounts(),
  blocked: emptyCounts(),
  simulated: emptyCounts(),
}

export function ebaySimulationExplicitlyOn(): boolean {
  return (process.env.EBAY_SIMULATION ?? "").trim().toLowerCase() === "true"
}

export function recordEbayMutation(kind: EbayMutationKind, outcome: EbayMutationOutcome): void {
  audit[outcome][kind] += 1
  console.warn(`[ebay-mutation-audit] ${outcome.toUpperCase()} ${kind} n=${audit[outcome][kind]}`)
}

export function getEbayMutationAudit(): {
  real: Counts
  blocked: Counts
  simulated: Counts
  realTotal: number
} {
  const realTotal = audit.real.quantity + audit.real.price + audit.real.end + audit.real.publish
  return {
    real: { ...audit.real },
    blocked: { ...audit.blocked },
    simulated: { ...audit.simulated },
    realTotal,
  }
}
