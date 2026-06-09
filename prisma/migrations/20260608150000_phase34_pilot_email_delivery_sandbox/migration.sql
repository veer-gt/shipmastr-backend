-- Phase 34: Pilot email delivery sandbox.
-- Additive sandbox attempt ledger only. No broad real email delivery, platform writes, courier calls, AWB, labels, or schedulers.

CREATE TABLE "email_delivery_attempts" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT,
  "notification_id" TEXT,
  "recipient_safe" TEXT,
  "provider" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "subject" TEXT,
  "safe_meta" JSONB,
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "email_delivery_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_delivery_attempts_merchant_id_status_idx"
  ON "email_delivery_attempts"("merchant_id", "status");
CREATE INDEX "email_delivery_attempts_notification_id_idx"
  ON "email_delivery_attempts"("notification_id");
CREATE INDEX "email_delivery_attempts_created_at_idx"
  ON "email_delivery_attempts"("created_at");
