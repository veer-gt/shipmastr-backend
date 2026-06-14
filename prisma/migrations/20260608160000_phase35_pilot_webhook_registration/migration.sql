-- Phase 35: pilot-gated platform webhook registration foundation.
-- Records dry-run/registration readiness only. No webhook secrets, raw headers,
-- raw provider payloads, or platform credentials are stored here.

CREATE TABLE "platform_webhook_registrations" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "platform" "StorePlatform" NOT NULL,
  "topic" TEXT NOT NULL,
  "callback_url_safe" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "external_webhook_id" TEXT,
  "registered_at" TIMESTAMP(3),
  "disabled_at" TIMESTAMP(3),
  "safe_meta" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_webhook_registrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_webhook_registrations_connection_id_topic_key"
  ON "platform_webhook_registrations"("connection_id", "topic");

CREATE INDEX "platform_webhook_registrations_merchant_id_connection_id_idx"
  ON "platform_webhook_registrations"("merchant_id", "connection_id");

CREATE INDEX "platform_webhook_registrations_merchant_id_status_idx"
  ON "platform_webhook_registrations"("merchant_id", "status");

CREATE INDEX "platform_webhook_registrations_platform_topic_idx"
  ON "platform_webhook_registrations"("platform", "topic");
