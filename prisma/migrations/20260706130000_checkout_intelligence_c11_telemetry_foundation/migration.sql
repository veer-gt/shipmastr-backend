CREATE TABLE "checkout_telemetry_sessions" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "seller_id" TEXT,
  "checkout_order_id" TEXT,
  "cart_id" TEXT,
  "quote_id" TEXT,
  "user_id" TEXT,
  "session_id" TEXT NOT NULL,
  "anonymous_id" TEXT,
  "email_hash" TEXT,
  "phone_hash" TEXT,
  "device_type" TEXT NOT NULL,
  "traffic_source" TEXT,
  "utm_source" TEXT,
  "utm_medium" TEXT,
  "utm_campaign" TEXT,
  "cart_value_minor" BIGINT NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "cart_size" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'STARTED',
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "abandoned_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_telemetry_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_telemetry_events" (
  "id" TEXT NOT NULL,
  "event_name" TEXT NOT NULL,
  "telemetry_session_id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "seller_id" TEXT,
  "checkout_order_id" TEXT,
  "checkout_payment_id" TEXT,
  "accounting_event_id" TEXT,
  "timeline_entry_id" TEXT,
  "request_id" TEXT,
  "idempotency_key" TEXT,
  "source" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_telemetry_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_telemetry_payment_attempts" (
  "id" TEXT NOT NULL,
  "telemetry_session_id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "seller_id" TEXT,
  "checkout_order_id" TEXT,
  "checkout_payment_id" TEXT,
  "payment_method" TEXT NOT NULL,
  "gateway_used" TEXT,
  "amount_minor" BIGINT NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" TEXT NOT NULL,
  "gateway_payment_id" TEXT,
  "gateway_order_id" TEXT,
  "error_code" TEXT,
  "error_message" TEXT,
  "attempt_number" INTEGER NOT NULL DEFAULT 1,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_telemetry_payment_attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_telemetry_failures" (
  "id" TEXT NOT NULL,
  "telemetry_session_id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "seller_id" TEXT,
  "checkout_order_id" TEXT,
  "checkout_payment_id" TEXT,
  "telemetry_payment_attempt_id" TEXT,
  "failure_stage" TEXT NOT NULL,
  "failure_reason" TEXT NOT NULL,
  "failure_code" TEXT,
  "failure_message" TEXT,
  "amount_at_risk_minor" BIGINT NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "is_recoverable" BOOLEAN NOT NULL DEFAULT false,
  "source" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_telemetry_failures_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "checkout_telemetry_sessions_merchant_id_session_id_key"
  ON "checkout_telemetry_sessions"("merchant_id", "session_id");
CREATE INDEX "checkout_telemetry_sessions_merchant_id_idx" ON "checkout_telemetry_sessions"("merchant_id");
CREATE INDEX "checkout_telemetry_sessions_seller_id_idx" ON "checkout_telemetry_sessions"("seller_id");
CREATE INDEX "checkout_telemetry_sessions_checkout_order_id_idx" ON "checkout_telemetry_sessions"("checkout_order_id");
CREATE INDEX "checkout_telemetry_sessions_quote_id_idx" ON "checkout_telemetry_sessions"("quote_id");
CREATE INDEX "checkout_telemetry_sessions_session_id_idx" ON "checkout_telemetry_sessions"("session_id");
CREATE INDEX "checkout_telemetry_sessions_status_idx" ON "checkout_telemetry_sessions"("status");
CREATE INDEX "checkout_telemetry_sessions_started_at_idx" ON "checkout_telemetry_sessions"("started_at");
CREATE INDEX "checkout_telemetry_sessions_created_at_idx" ON "checkout_telemetry_sessions"("created_at");

CREATE UNIQUE INDEX "checkout_telemetry_events_telemetry_session_id_event_name_idempotency_key_key"
  ON "checkout_telemetry_events"("telemetry_session_id", "event_name", "idempotency_key");
CREATE INDEX "checkout_telemetry_events_telemetry_session_id_idx" ON "checkout_telemetry_events"("telemetry_session_id");
CREATE INDEX "checkout_telemetry_events_merchant_id_idx" ON "checkout_telemetry_events"("merchant_id");
CREATE INDEX "checkout_telemetry_events_seller_id_idx" ON "checkout_telemetry_events"("seller_id");
CREATE INDEX "checkout_telemetry_events_checkout_order_id_idx" ON "checkout_telemetry_events"("checkout_order_id");
CREATE INDEX "checkout_telemetry_events_checkout_payment_id_idx" ON "checkout_telemetry_events"("checkout_payment_id");
CREATE INDEX "checkout_telemetry_events_event_name_idx" ON "checkout_telemetry_events"("event_name");
CREATE INDEX "checkout_telemetry_events_source_idx" ON "checkout_telemetry_events"("source");
CREATE INDEX "checkout_telemetry_events_occurred_at_idx" ON "checkout_telemetry_events"("occurred_at");
CREATE INDEX "checkout_telemetry_events_created_at_idx" ON "checkout_telemetry_events"("created_at");

CREATE INDEX "checkout_telemetry_payment_attempts_telemetry_session_id_idx" ON "checkout_telemetry_payment_attempts"("telemetry_session_id");
CREATE INDEX "checkout_telemetry_payment_attempts_merchant_id_idx" ON "checkout_telemetry_payment_attempts"("merchant_id");
CREATE INDEX "checkout_telemetry_payment_attempts_seller_id_idx" ON "checkout_telemetry_payment_attempts"("seller_id");
CREATE INDEX "checkout_telemetry_payment_attempts_checkout_order_id_idx" ON "checkout_telemetry_payment_attempts"("checkout_order_id");
CREATE INDEX "checkout_telemetry_payment_attempts_checkout_payment_id_idx" ON "checkout_telemetry_payment_attempts"("checkout_payment_id");
CREATE INDEX "checkout_telemetry_payment_attempts_payment_method_idx" ON "checkout_telemetry_payment_attempts"("payment_method");
CREATE INDEX "checkout_telemetry_payment_attempts_status_idx" ON "checkout_telemetry_payment_attempts"("status");
CREATE INDEX "checkout_telemetry_payment_attempts_started_at_idx" ON "checkout_telemetry_payment_attempts"("started_at");
CREATE INDEX "checkout_telemetry_payment_attempts_created_at_idx" ON "checkout_telemetry_payment_attempts"("created_at");

CREATE INDEX "checkout_telemetry_failures_telemetry_session_id_idx" ON "checkout_telemetry_failures"("telemetry_session_id");
CREATE INDEX "checkout_telemetry_failures_merchant_id_idx" ON "checkout_telemetry_failures"("merchant_id");
CREATE INDEX "checkout_telemetry_failures_seller_id_idx" ON "checkout_telemetry_failures"("seller_id");
CREATE INDEX "checkout_telemetry_failures_checkout_order_id_idx" ON "checkout_telemetry_failures"("checkout_order_id");
CREATE INDEX "checkout_telemetry_failures_checkout_payment_id_idx" ON "checkout_telemetry_failures"("checkout_payment_id");
CREATE INDEX "checkout_telemetry_failures_telemetry_payment_attempt_id_idx" ON "checkout_telemetry_failures"("telemetry_payment_attempt_id");
CREATE INDEX "checkout_telemetry_failures_failure_stage_idx" ON "checkout_telemetry_failures"("failure_stage");
CREATE INDEX "checkout_telemetry_failures_failure_code_idx" ON "checkout_telemetry_failures"("failure_code");
CREATE INDEX "checkout_telemetry_failures_source_idx" ON "checkout_telemetry_failures"("source");
CREATE INDEX "checkout_telemetry_failures_created_at_idx" ON "checkout_telemetry_failures"("created_at");

ALTER TABLE "checkout_telemetry_events"
  ADD CONSTRAINT "checkout_telemetry_events_telemetry_session_id_fkey"
  FOREIGN KEY ("telemetry_session_id") REFERENCES "checkout_telemetry_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "checkout_telemetry_payment_attempts"
  ADD CONSTRAINT "checkout_telemetry_payment_attempts_telemetry_session_id_fkey"
  FOREIGN KEY ("telemetry_session_id") REFERENCES "checkout_telemetry_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "checkout_telemetry_failures"
  ADD CONSTRAINT "checkout_telemetry_failures_telemetry_session_id_fkey"
  FOREIGN KEY ("telemetry_session_id") REFERENCES "checkout_telemetry_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "checkout_telemetry_failures"
  ADD CONSTRAINT "checkout_telemetry_failures_telemetry_payment_attempt_id_fkey"
  FOREIGN KEY ("telemetry_payment_attempt_id") REFERENCES "checkout_telemetry_payment_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
