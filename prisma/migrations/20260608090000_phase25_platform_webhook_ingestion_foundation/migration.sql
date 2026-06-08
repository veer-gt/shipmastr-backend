-- Phase 25: Platform webhook ingestion foundation.
-- Additive staging table only. No external webhook registration, platform writes, orders, shipments, or workers.

CREATE TABLE "platform_webhook_events" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "connection_id" TEXT,
  "platform" "StorePlatform" NOT NULL,
  "topic" TEXT NOT NULL,
  "external_event_id" TEXT,
  "event_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  "safe_summary" JSONB,
  "warnings" JSONB,
  "errors" JSONB,
  "import_job_id" TEXT,
  "import_item_id" TEXT,
  "dedupe_key" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_webhook_events_merchant_id_dedupe_key_key"
  ON "platform_webhook_events"("merchant_id", "dedupe_key");
CREATE INDEX "platform_webhook_events_merchant_id_platform_idx"
  ON "platform_webhook_events"("merchant_id", "platform");
CREATE INDEX "platform_webhook_events_merchant_id_status_idx"
  ON "platform_webhook_events"("merchant_id", "status");
CREATE INDEX "platform_webhook_events_connection_id_idx"
  ON "platform_webhook_events"("connection_id");
CREATE INDEX "platform_webhook_events_received_at_idx"
  ON "platform_webhook_events"("received_at");
