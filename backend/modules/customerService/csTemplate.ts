import {
  extractBuyerFirstName,
  formatCustomerEta,
  formatDeliveryLocationCustomerText,
  renderGreeting,
} from "./csBuyerName"

export const LEGACY_THANK_YOU_TEMPLATE =
  "Thank you for your order. We appreciate your purchase and will keep you updated as your order progresses."

export const LEGACY_SHIPPED_TEMPLATE =
  "Good news — your order has shipped. We’ll continue monitoring the delivery and keep you updated if anything changes."

export const LEGACY_DELAYED_TEMPLATE =
  "We wanted to let you know that your delivery has been delayed. The latest estimated delivery date is {{estimated_delivery}}. We’re continuing to monitor the shipment and will keep you updated."

export const LEGACY_DELIVERED_TEMPLATE =
  "Your order has been marked as delivered. Please check around the delivery location and with anyone at the address who may have received it. If you need any help, please let us know."

export const THANK_YOU_TEMPLATE_WITH_ETA =
  "{{greeting}} thank you for your order. We’ve received it, and your order is now being prepared for shipment. Based on the latest delivery information, it is currently expected to arrive by {{estimated_delivery}}. We’ll keep an eye on the order as it moves through the delivery process and will let you know if anything important changes."

export const THANK_YOU_TEMPLATE_NO_ETA =
  "{{greeting}} thank you for your order. We’ve received it, and your order is now being prepared for shipment. We’ll keep an eye on it as it moves through the delivery process and will send you an update as soon as shipping information becomes available."

export const SHIPPED_TEMPLATE_WITH_ETA =
  "{{greeting}} good news — your order has shipped and is now on the way. The current estimated delivery date is {{estimated_delivery}}. We’ll continue monitoring the shipment and will let you know if the delivery estimate or status changes."

export const SHIPPED_TEMPLATE_NO_ETA =
  "{{greeting}} good news — your order has shipped and is now on the way. We’ll continue monitoring the shipment and will keep you updated if anything changes along the way."

export const DELAYED_TEMPLATE_WITH_ETA =
  "{{greeting}} we wanted to let you know that your order is taking a little longer than expected. The latest estimated delivery date is {{estimated_delivery}}. We’re actively monitoring the shipment and will keep you updated if the delivery status or expected date changes. There’s nothing you need to do right now."

export const DELAYED_TEMPLATE_NO_ETA =
  "{{greeting}} we wanted to let you know that your order is taking a little longer than expected. We’re actively monitoring the shipment and will update you as soon as new delivery information becomes available. There’s nothing you need to do right now."

export const DELIVERED_TEMPLATE_LOCATION_PHOTO =
  "{{greeting}} your order has been marked as delivered today. The delivery update shows that it was left {{delivery_location}}. We’ve included the delivery photo below for your reference. Please check the delivery area and with anyone at the address who may have received it. If you have any trouble locating the package, just reply to this message and we’ll be happy to help."

export const DELIVERED_TEMPLATE_LOCATION_ONLY =
  "{{greeting}} your order has been marked as delivered today. The delivery update shows that it was left {{delivery_location}}. Please check the delivery area and with anyone at the address who may have received it. If you have any trouble locating the package, just reply to this message and we’ll be happy to help."

export const DELIVERED_TEMPLATE_PHOTO_ONLY =
  "{{greeting}} your order has been marked as delivered today. We’ve included the delivery photo below for your reference. Please check the delivery area and with anyone at the address who may have received it. If you have any trouble locating the package, just reply to this message and we’ll be happy to help."

export const DELIVERED_TEMPLATE_NEITHER =
  "{{greeting}} your order has been marked as delivered today. Please check the delivery area and with anyone at the address who may have received it. If you have any trouble locating the package, just reply to this message and we’ll be happy to help."

export const DEFAULT_THANK_YOU_TEMPLATE = THANK_YOU_TEMPLATE_WITH_ETA
export const DEFAULT_SHIPPED_TEMPLATE = SHIPPED_TEMPLATE_WITH_ETA
export const DEFAULT_DELAYED_TEMPLATE = DELAYED_TEMPLATE_WITH_ETA
export const DEFAULT_DELIVERED_TEMPLATE = DELIVERED_TEMPLATE_LOCATION_PHOTO

/** @deprecated Do not claim a carrier ETA when none exists. Kept only for legacy fixture identity. */
export const DELAYED_ETA_FALLBACK = "The carrier has provided an updated delivery estimate."

const SHARED_PLACEHOLDERS = [
  "greeting",
  "buyer_first_name",
  "buyer_username",
  "order_id",
  "store_name",
] as const

export const THANK_YOU_PLACEHOLDERS = [...SHARED_PLACEHOLDERS, "estimated_delivery"] as const
export const SHIPPED_PLACEHOLDERS = [...SHARED_PLACEHOLDERS, "estimated_delivery"] as const
export const DELAYED_PLACEHOLDERS = [...SHARED_PLACEHOLDERS, "estimated_delivery"] as const
export const DELIVERED_PLACEHOLDERS = [...SHARED_PLACEHOLDERS, "delivery_location"] as const

export type CsAutomationType = "THANK_YOU" | "SHIPPED" | "DELAYED" | "DELIVERED"
export type SourceStatusEventType = "SOURCE_SHIPPED" | "SOURCE_DELAYED" | "SOURCE_DELIVERED"

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

export function placeholdersForType(type: CsAutomationType): readonly string[] {
  if (type === "SHIPPED") return SHIPPED_PLACEHOLDERS
  if (type === "DELAYED") return DELAYED_PLACEHOLDERS
  if (type === "DELIVERED") return DELIVERED_PLACEHOLDERS
  return THANK_YOU_PLACEHOLDERS
}

export function defaultTemplateForType(type: CsAutomationType): string {
  if (type === "SHIPPED") return DEFAULT_SHIPPED_TEMPLATE
  if (type === "DELAYED") return DEFAULT_DELAYED_TEMPLATE
  if (type === "DELIVERED") return DEFAULT_DELIVERED_TEMPLATE
  return DEFAULT_THANK_YOU_TEMPLATE
}

export function automationTypeForSourceEvent(eventType: string): CsAutomationType | null {
  if (eventType === "SOURCE_SHIPPED") return "SHIPPED"
  if (eventType === "SOURCE_DELAYED") return "DELAYED"
  if (eventType === "SOURCE_DELIVERED") return "DELIVERED"
  return null
}

export function findUnsupportedPlaceholders(template: string): string[] {
  return findUnsupportedPlaceholdersFor("THANK_YOU", template)
}

export function findUnsupportedPlaceholdersFor(type: CsAutomationType, template: string): string[] {
  const allowed = new Set<string>(placeholdersForType(type))
  const found = new Set<string>()
  const re = new RegExp(PLACEHOLDER_RE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) {
    const key = m[1]
    if (!allowed.has(key)) found.add(key)
  }
  return [...found]
}

export function templateMentionsAmazon(template: string): boolean {
  return /\bamazon\b/i.test(template)
}

function scrubAmazon(value: string): string {
  return value.replace(/\bamazon\b/gi, " ").replace(/\s+/g, " ").trim()
}

function tidyCustomerText(value: string): string {
  return value
    .replace(PLACEHOLDER_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ +([.,!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export type TemplateVars = {
  buyer_username: string
  order_id: string
  store_name: string
  buyer_name?: string | null
  estimated_delivery?: string | null
  delivery_location?: string | null
  has_delivery_photo?: boolean
}

export function isUntouchedSystemTemplate(type: CsAutomationType, template: string): boolean {
  const body = template.trim()
  const known = systemTemplatesForType(type)
  return known.some(t => t.trim() === body)
}

function systemTemplatesForType(type: CsAutomationType): string[] {
  if (type === "THANK_YOU") {
    return [LEGACY_THANK_YOU_TEMPLATE, THANK_YOU_TEMPLATE_WITH_ETA, THANK_YOU_TEMPLATE_NO_ETA]
  }
  if (type === "SHIPPED") {
    return [LEGACY_SHIPPED_TEMPLATE, SHIPPED_TEMPLATE_WITH_ETA, SHIPPED_TEMPLATE_NO_ETA]
  }
  if (type === "DELAYED") {
    return [LEGACY_DELAYED_TEMPLATE, DELAYED_TEMPLATE_WITH_ETA, DELAYED_TEMPLATE_NO_ETA]
  }
  return [
    LEGACY_DELIVERED_TEMPLATE,
    DELIVERED_TEMPLATE_LOCATION_PHOTO,
    DELIVERED_TEMPLATE_LOCATION_ONLY,
    DELIVERED_TEMPLATE_PHOTO_ONLY,
    DELIVERED_TEMPLATE_NEITHER,
  ]
}

export function resolveTemplateForRender(
  type: CsAutomationType,
  stored: string,
  flags: { hasEta: boolean; hasLocation: boolean; hasPhoto: boolean }
): string {
  if (!isUntouchedSystemTemplate(type, stored)) return stored
  if (type === "THANK_YOU") return flags.hasEta ? THANK_YOU_TEMPLATE_WITH_ETA : THANK_YOU_TEMPLATE_NO_ETA
  if (type === "SHIPPED") return flags.hasEta ? SHIPPED_TEMPLATE_WITH_ETA : SHIPPED_TEMPLATE_NO_ETA
  if (type === "DELAYED") return flags.hasEta ? DELAYED_TEMPLATE_WITH_ETA : DELAYED_TEMPLATE_NO_ETA
  if (flags.hasLocation && flags.hasPhoto) return DELIVERED_TEMPLATE_LOCATION_PHOTO
  if (flags.hasLocation) return DELIVERED_TEMPLATE_LOCATION_ONLY
  if (flags.hasPhoto) return DELIVERED_TEMPLATE_PHOTO_ONLY
  return DELIVERED_TEMPLATE_NEITHER
}

function valueForKey(key: string, vars: TemplateVars, resolved: ResolvedRender): string {
  if (key === "greeting") return resolved.greeting
  if (key === "buyer_first_name") return resolved.firstName ?? ""
  if (key === "buyer_username") return scrubAmazon(vars.buyer_username)
  if (key === "order_id") return scrubAmazon(vars.order_id)
  if (key === "store_name") return scrubAmazon(vars.store_name)
  if (key === "estimated_delivery") return resolved.eta ?? ""
  if (key === "delivery_location") return resolved.location ?? ""
  return ""
}

type ResolvedRender = {
  greeting: string
  firstName: string | null
  eta: string | null
  location: string | null
}

export function removeDeliveryPhotoClaim(text: string): string {
  return tidyCustomerText(text.replace(/\s*We[’']ve included the delivery photo below for your reference\.\s*/gi, " "))
}

export function renderThankYouTemplate(
  template: string,
  vars: TemplateVars
): string {
  return renderAutomationTemplate("THANK_YOU", template, vars)
}

export function renderAutomationTemplate(
  type: CsAutomationType,
  template: string,
  vars: TemplateVars
): string {
  const firstName = extractBuyerFirstName(vars.buyer_name, vars.buyer_username)
  const greeting = renderGreeting(firstName)
  const eta = formatCustomerEta(vars.estimated_delivery ?? null)
  const location = formatDeliveryLocationCustomerText(vars.delivery_location ?? null)
  const hasPhoto = Boolean(vars.has_delivery_photo)
  const source = resolveTemplateForRender(type, template, {
    hasEta: Boolean(eta),
    hasLocation: Boolean(location),
    hasPhoto,
  })
  const unsupported = findUnsupportedPlaceholdersFor(type, source)
  if (unsupported.length > 0) {
    throw new Error(`Unsupported placeholders: ${unsupported.map(k => `{{${k}}}`).join(", ")}`)
  }
  if (templateMentionsAmazon(source)) {
    throw new Error("Template must not mention Amazon")
  }
  const resolved: ResolvedRender = { greeting, firstName, eta, location }
  const rendered = source.replace(PLACEHOLDER_RE, (_all, key: string) => valueForKey(key, vars, resolved))
  const text = tidyCustomerText(rendered)
  if (!text || /\bundefined\b|\bnull\b/i.test(text)) {
    throw new Error("invalid_template_render")
  }
  if (templateMentionsAmazon(text)) {
    throw new Error("rendered_message_mentions_amazon")
  }
  if (/\basin\b|shipmentid|packageindex/i.test(text)) {
    throw new Error("rendered_message_leaked_internal")
  }
  return text
}

export function isCancelledOrderStatus(parts: Array<string | null | undefined>): boolean {
  const blob = parts.map(p => (p ?? "").toUpperCase()).join(" ")
  return blob.includes("CANCEL")
}

export function evaluateThankYouEligibility(input: {
  enabled: boolean
  ebayOrderId: string
  buyerUsername: string | null
  orderStatus?: string | null
  fulfillmentStatus?: string | null
  paymentStatus?: string | null
}): { ok: true } | { ok: false; reason: string } {
  return evaluateAutomationEligibility({
    enabled: input.enabled,
    ebayOrderId: input.ebayOrderId,
    buyerUsername: input.buyerUsername,
    orderStatus: input.orderStatus,
    fulfillmentStatus: input.fulfillmentStatus,
    paymentStatus: input.paymentStatus,
    linked: true,
    eventType: "THANK_YOU",
  })
}

export function evaluateAutomationEligibility(input: {
  enabled: boolean
  ebayOrderId: string
  buyerUsername: string | null
  orderStatus?: string | null
  fulfillmentStatus?: string | null
  paymentStatus?: string | null
  linked?: boolean
  eventType?: string | null
  expectedEventType?: string | null
}): { ok: true } | { ok: false; reason: string } {
  if (!input.enabled) return { ok: false, reason: "DISABLED" }
  if (!input.ebayOrderId.trim()) return { ok: false, reason: "INVALID_EVENT" }
  if (!input.buyerUsername?.trim()) return { ok: false, reason: "NO_BUYER" }
  if (isCancelledOrderStatus([input.orderStatus, input.fulfillmentStatus, input.paymentStatus])) {
    return { ok: false, reason: "CANCELLED_ORDER" }
  }
  if (input.linked === false) return { ok: false, reason: "UNLINKED_SOURCE" }
  if (input.expectedEventType && input.eventType !== input.expectedEventType) {
    return { ok: false, reason: "INVALID_EVENT" }
  }
  return { ok: true }
}
