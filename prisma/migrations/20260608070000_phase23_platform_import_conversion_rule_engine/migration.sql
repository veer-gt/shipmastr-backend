-- Phase 23: Platform import conversion rule engine.
-- Additive conversion audit/link model only. No provider/platform write behavior.

CREATE TABLE "platform_import_conversions" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "import_item_id" TEXT NOT NULL,
  "platform_order_import_id" TEXT,
  "order_id" TEXT,
  "shipment_id" TEXT,
  "status" TEXT NOT NULL,
  "queue" TEXT,
  "warnings" JSONB,
  "reason_codes" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_import_conversions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_import_conversions_merchant_id_import_item_id_key"
  ON "platform_import_conversions"("merchant_id", "import_item_id");
CREATE INDEX "platform_import_conversions_merchant_id_status_idx"
  ON "platform_import_conversions"("merchant_id", "status");
CREATE INDEX "platform_import_conversions_order_id_idx"
  ON "platform_import_conversions"("order_id");
CREATE INDEX "platform_import_conversions_shipment_id_idx"
  ON "platform_import_conversions"("shipment_id");
