/**
 * Pure sold-item auto-restock decision helpers (no I/O).
 */

/** Target live eBay quantity after a sold-item restock (never lower stock that is already >= target). */
export const SOLD_ITEM_RESTOCK_TARGET_QUANTITY = 3

/** Restock only when live quantity is strictly below target. */
export function shouldRestockSoldItem(
  liveQuantity: number,
  target: number = SOLD_ITEM_RESTOCK_TARGET_QUANTITY
): boolean {
  return Number.isFinite(liveQuantity) && liveQuantity < target
}
