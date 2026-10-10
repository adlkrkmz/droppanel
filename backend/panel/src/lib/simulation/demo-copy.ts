/**
 * Demo / simulation labels — visually quiet in future UI.
 * No claims of live production data.
 */

export const DEMO_MODE_LABEL = 'DEMO MODE'

export const DEMO_MODE_HINT =
  'Illustrative simulation for preview. Not connected to live market feeds.'

export const SIMULATION_DISCLAIMER =
  'Simulated demo data for creative preview only.'

export const SCANNER_PLACEHOLDER = 'Enter a product keyword or ASIN…'

export const SCANNER_STATUS_LABELS = {
  idle: 'Ready',
  typing: 'Input',
  scanning: 'Scanning',
  analyzing: 'Analyzing',
  complete: 'Complete',
} as const
