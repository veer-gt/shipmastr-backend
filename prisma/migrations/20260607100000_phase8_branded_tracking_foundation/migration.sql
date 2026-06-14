-- Phase 8 branded tracking foundation.
-- Adds public-safe tracking token fields to the existing Shipment candidate-equivalent.
ALTER TABLE "shipments"
  ADD COLUMN "tracking_token" TEXT,
  ADD COLUMN "tracking_public_url" TEXT,
  ADD COLUMN "tracking_status" TEXT,
  ADD COLUMN "tracking_last_synced_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "shipments_tracking_token_key" ON "shipments"("tracking_token");
CREATE INDEX "shipments_tracking_token_idx" ON "shipments"("tracking_token");
