CREATE TABLE "checkout_rules_versions" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "rules_json" JSONB NOT NULL,
  "created_by" TEXT,
  "activated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_rules_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_merchant_settings" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "active_rules_version_id" TEXT,
  "quote_ttl_seconds" INTEGER NOT NULL DEFAULT 900,
  "mode" TEXT NOT NULL DEFAULT 'mock',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_merchant_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_quotes" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "rules_version_id" TEXT,
  "pincode" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "items_json" JSONB NOT NULL,
  "items_total_minor" BIGINT NOT NULL DEFAULT 0,
  "options_json" JSONB NOT NULL,
  "risk_notes" JSONB,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_quotes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_orders" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "quote_id" TEXT NOT NULL,
  "fulfillment_order_id" TEXT,
  "mode" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "pincode" TEXT NOT NULL,
  "items_json" JSONB NOT NULL,
  "customer_json" JSONB NOT NULL,
  "shipping_address_json" JSONB,
  "items_total_minor" BIGINT NOT NULL DEFAULT 0,
  "cod_fee_minor" BIGINT NOT NULL DEFAULT 0,
  "discount_minor" BIGINT NOT NULL DEFAULT 0,
  "grand_total_minor" BIGINT NOT NULL DEFAULT 0,
  "pay_now_minor" BIGINT NOT NULL DEFAULT 0,
  "pay_on_delivery_minor" BIGINT NOT NULL DEFAULT 0,
  "advance_paid_minor" BIGINT NOT NULL DEFAULT 0,
  "cod_collection_status" TEXT NOT NULL DEFAULT 'none',
  "cod_collection_amount_minor" BIGINT NOT NULL DEFAULT 0,
  "cod_collection_method" TEXT,
  "cod_collection_reference" TEXT,
  "cod_collected_at" TIMESTAMP(3),
  "order_token_hash" TEXT NOT NULL,
  "token_issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "advance_expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_order_timeline" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_order_timeline_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_payments" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "amount_minor" BIGINT NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "purpose" TEXT NOT NULL,
  "gateway" TEXT NOT NULL DEFAULT 'mock',
  "state" TEXT NOT NULL DEFAULT 'created',
  "gateway_intent_ref" TEXT,
  "gateway_order_ref" TEXT,
  "gateway_payment_ref" TEXT,
  "captured_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_accounting_events" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "order_id" TEXT,
  "payment_id" TEXT,
  "event_type" TEXT NOT NULL,
  "source_ref" TEXT NOT NULL,
  "amount_minor" BIGINT,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_accounting_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_idempotency_keys" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "response_json" JSONB NOT NULL,
  "status_code" INTEGER NOT NULL,
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_idempotency_keys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_audit_logs" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "order_id" TEXT,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "actor" TEXT NOT NULL DEFAULT 'checkout',
  "safe_meta" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "checkout_rules_versions_merchant_id_version_key"
  ON "checkout_rules_versions"("merchant_id", "version");
CREATE INDEX "checkout_rules_versions_merchant_id_status_idx"
  ON "checkout_rules_versions"("merchant_id", "status");
CREATE INDEX "checkout_rules_versions_created_at_idx"
  ON "checkout_rules_versions"("created_at");

CREATE UNIQUE INDEX "checkout_merchant_settings_merchant_id_key"
  ON "checkout_merchant_settings"("merchant_id");
CREATE INDEX "checkout_merchant_settings_active_rules_version_id_idx"
  ON "checkout_merchant_settings"("active_rules_version_id");

CREATE INDEX "checkout_quotes_merchant_id_idx" ON "checkout_quotes"("merchant_id");
CREATE INDEX "checkout_quotes_expires_at_idx" ON "checkout_quotes"("expires_at");
CREATE INDEX "checkout_quotes_created_at_idx" ON "checkout_quotes"("created_at");

CREATE INDEX "checkout_orders_merchant_id_idx" ON "checkout_orders"("merchant_id");
CREATE INDEX "checkout_orders_quote_id_idx" ON "checkout_orders"("quote_id");
CREATE INDEX "checkout_orders_fulfillment_order_id_idx" ON "checkout_orders"("fulfillment_order_id");
CREATE INDEX "checkout_orders_state_idx" ON "checkout_orders"("state");
CREATE INDEX "checkout_orders_mode_idx" ON "checkout_orders"("mode");
CREATE INDEX "checkout_orders_created_at_idx" ON "checkout_orders"("created_at");

CREATE INDEX "checkout_order_timeline_merchant_id_idx" ON "checkout_order_timeline"("merchant_id");
CREATE INDEX "checkout_order_timeline_order_id_idx" ON "checkout_order_timeline"("order_id");
CREATE INDEX "checkout_order_timeline_type_idx" ON "checkout_order_timeline"("type");
CREATE INDEX "checkout_order_timeline_created_at_idx" ON "checkout_order_timeline"("created_at");

CREATE INDEX "checkout_payments_merchant_id_idx" ON "checkout_payments"("merchant_id");
CREATE INDEX "checkout_payments_order_id_idx" ON "checkout_payments"("order_id");
CREATE INDEX "checkout_payments_state_idx" ON "checkout_payments"("state");
CREATE INDEX "checkout_payments_gateway_order_ref_idx" ON "checkout_payments"("gateway_order_ref");
CREATE INDEX "checkout_payments_gateway_payment_ref_idx" ON "checkout_payments"("gateway_payment_ref");

CREATE INDEX "checkout_accounting_events_merchant_id_idx" ON "checkout_accounting_events"("merchant_id");
CREATE INDEX "checkout_accounting_events_order_id_idx" ON "checkout_accounting_events"("order_id");
CREATE INDEX "checkout_accounting_events_payment_id_idx" ON "checkout_accounting_events"("payment_id");
CREATE INDEX "checkout_accounting_events_event_type_idx" ON "checkout_accounting_events"("event_type");
CREATE INDEX "checkout_accounting_events_source_ref_idx" ON "checkout_accounting_events"("source_ref");
CREATE INDEX "checkout_accounting_events_created_at_idx" ON "checkout_accounting_events"("created_at");

CREATE UNIQUE INDEX "checkout_idempotency_keys_merchant_id_operation_idempotency_key_key"
  ON "checkout_idempotency_keys"("merchant_id", "operation", "idempotency_key");
CREATE INDEX "checkout_idempotency_keys_merchant_id_idx" ON "checkout_idempotency_keys"("merchant_id");
CREATE INDEX "checkout_idempotency_keys_operation_idx" ON "checkout_idempotency_keys"("operation");
CREATE INDEX "checkout_idempotency_keys_expires_at_idx" ON "checkout_idempotency_keys"("expires_at");

CREATE INDEX "checkout_audit_logs_merchant_id_idx" ON "checkout_audit_logs"("merchant_id");
CREATE INDEX "checkout_audit_logs_order_id_idx" ON "checkout_audit_logs"("order_id");
CREATE INDEX "checkout_audit_logs_action_idx" ON "checkout_audit_logs"("action");
CREATE INDEX "checkout_audit_logs_created_at_idx" ON "checkout_audit_logs"("created_at");

ALTER TABLE "checkout_rules_versions"
  ADD CONSTRAINT "checkout_rules_versions_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "checkout_merchant_settings"
  ADD CONSTRAINT "checkout_merchant_settings_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checkout_merchant_settings"
  ADD CONSTRAINT "checkout_merchant_settings_active_rules_version_id_fkey"
  FOREIGN KEY ("active_rules_version_id") REFERENCES "checkout_rules_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "checkout_quotes"
  ADD CONSTRAINT "checkout_quotes_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checkout_quotes"
  ADD CONSTRAINT "checkout_quotes_rules_version_id_fkey"
  FOREIGN KEY ("rules_version_id") REFERENCES "checkout_rules_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "checkout_orders"
  ADD CONSTRAINT "checkout_orders_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checkout_orders"
  ADD CONSTRAINT "checkout_orders_quote_id_fkey"
  FOREIGN KEY ("quote_id") REFERENCES "checkout_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "checkout_orders"
  ADD CONSTRAINT "checkout_orders_fulfillment_order_id_fkey"
  FOREIGN KEY ("fulfillment_order_id") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "checkout_order_timeline"
  ADD CONSTRAINT "checkout_order_timeline_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "checkout_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "checkout_payments"
  ADD CONSTRAINT "checkout_payments_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checkout_payments"
  ADD CONSTRAINT "checkout_payments_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "checkout_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "checkout_accounting_events"
  ADD CONSTRAINT "checkout_accounting_events_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checkout_accounting_events"
  ADD CONSTRAINT "checkout_accounting_events_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "checkout_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checkout_accounting_events"
  ADD CONSTRAINT "checkout_accounting_events_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "checkout_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "checkout_idempotency_keys"
  ADD CONSTRAINT "checkout_idempotency_keys_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "checkout_audit_logs"
  ADD CONSTRAINT "checkout_audit_logs_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checkout_audit_logs"
  ADD CONSTRAINT "checkout_audit_logs_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "checkout_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
