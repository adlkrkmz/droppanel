-- Delivery proof metadata on the linked order (workspace+store scoped).
-- Media send audit on customer_service_sends.
-- Upgrade only exact previous default templates; do not enable automations.

ALTER TABLE ebay_orders
  ADD COLUMN IF NOT EXISTS delivery_proof_source_url TEXT,
  ADD COLUMN IF NOT EXISTS delivery_proof_r2_url TEXT,
  ADD COLUMN IF NOT EXISTS delivery_proof_content_type TEXT,
  ADD COLUMN IF NOT EXISTS delivery_proof_stored_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_proof_source_mailbox_message_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_ebay_orders_delivery_proof_mailbox
  ON ebay_orders (workspace_id, store_id, delivery_proof_source_mailbox_message_id)
  WHERE delivery_proof_source_mailbox_message_id IS NOT NULL;

ALTER TABLE customer_service_sends
  ADD COLUMN IF NOT EXISTS media_attempted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS media_included BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_result TEXT;

UPDATE customer_service_automations
SET template_body = '{{greeting}} thank you for your order. We’ve received it, and your order is now being prepared for shipment. Based on the latest delivery information, it is currently expected to arrive by {{estimated_delivery}}. We’ll keep an eye on the order as it moves through the delivery process and will let you know if anything important changes.',
    updated_at = NOW()
WHERE automation_type = 'THANK_YOU'
  AND template_body = 'Thank you for your order. We appreciate your purchase and will keep you updated as your order progresses.';

UPDATE customer_service_automations
SET template_body = '{{greeting}} good news — your order has shipped and is now on the way. The current estimated delivery date is {{estimated_delivery}}. We’ll continue monitoring the shipment and will let you know if the delivery estimate or status changes.',
    updated_at = NOW()
WHERE automation_type = 'SHIPPED'
  AND template_body = 'Good news — your order has shipped. We’ll continue monitoring the delivery and keep you updated if anything changes.';

UPDATE customer_service_automations
SET template_body = '{{greeting}} we wanted to let you know that your order is taking a little longer than expected. The latest estimated delivery date is {{estimated_delivery}}. We’re actively monitoring the shipment and will keep you updated if the delivery status or expected date changes. There’s nothing you need to do right now.',
    updated_at = NOW()
WHERE automation_type = 'DELAYED'
  AND template_body = 'We wanted to let you know that your delivery has been delayed. The latest estimated delivery date is {{estimated_delivery}}. We’re continuing to monitor the shipment and will keep you updated.';

UPDATE customer_service_automations
SET template_body = '{{greeting}} your order has been marked as delivered today. The delivery update shows that it was left {{delivery_location}}. We’ve included the delivery photo below for your reference. Please check the delivery area and with anyone at the address who may have received it. If you have any trouble locating the package, just reply to this message and we’ll be happy to help.',
    updated_at = NOW()
WHERE automation_type = 'DELIVERED'
  AND template_body = 'Your order has been marked as delivered. Please check around the delivery location and with anyone at the address who may have received it. If you need any help, please let us know.';
