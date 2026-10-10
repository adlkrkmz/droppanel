import {
  hasUsableAccess,
  type ProductAccessRecord,
  type ProductId,
} from "./types"

export type PostLoginDestination = "/dashboard/ebay"

export function resolvePostLoginDestination(
  access: ProductAccessRecord[]
): PostLoginDestination {
  void access
  return "/dashboard/ebay"
}

export function productDashboardPath(product: ProductId): string {
  return "/dashboard/ebay"
}

export function productOnboardingPath(product: ProductId): string {
  return "/dashboard/ebay/onboarding"
}
