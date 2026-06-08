-- Phase 24: Merchant failed import notifications.
-- Additive in-app notification foundation only. No email sending, platform writes, courier calls, or background workers.

CREATE TABLE "merchant_notifications" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'UNREAD',
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "action_label" TEXT,
  "action_url" TEXT,
  "source_type" TEXT,
  "source_id" TEXT,
  "source_meta" JSONB,
  "dedupe_key" TEXT,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_notification_preferences" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "in_app_enabled" BOOLEAN NOT NULL DEFAULT true,
  "import_failed_enabled" BOOLEAN NOT NULL DEFAULT true,
  "needs_review_enabled" BOOLEAN NOT NULL DEFAULT true,
  "duplicate_enabled" BOOLEAN NOT NULL DEFAULT true,
  "conversion_blocked_enabled" BOOLEAN NOT NULL DEFAULT true,
  "digest_enabled" BOOLEAN NOT NULL DEFAULT true,
  "email_enabled" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_notifications_merchant_id_dedupe_key_key"
  ON "merchant_notifications"("merchant_id", "dedupe_key");
CREATE INDEX "merchant_notifications_merchant_id_status_idx"
  ON "merchant_notifications"("merchant_id", "status");
CREATE INDEX "merchant_notifications_merchant_id_type_idx"
  ON "merchant_notifications"("merchant_id", "type");
CREATE INDEX "merchant_notifications_merchant_id_severity_idx"
  ON "merchant_notifications"("merchant_id", "severity");
CREATE INDEX "merchant_notifications_merchant_id_created_at_idx"
  ON "merchant_notifications"("merchant_id", "created_at");
CREATE UNIQUE INDEX "merchant_notification_preferences_merchant_id_key"
  ON "merchant_notification_preferences"("merchant_id");
