-- Phase 5B order ingestion foundation.
-- Additive-only: preserve existing order, pickup, and shipment behavior.

ALTER TYPE "OrderStatus" ADD VALUE 'NEEDS_ATTENTION';

ALTER TABLE "Order"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "importBatchId" TEXT,
  ADD COLUMN "buyerEmail" TEXT,
  ADD COLUMN "buyerAltPhone" TEXT,
  ADD COLUMN "landmark" TEXT,
  ADD COLUMN "country" TEXT NOT NULL DEFAULT 'IN',
  ADD COLUMN "declaredValue" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "packageLengthMm" INTEGER,
  ADD COLUMN "packageWidthMm" INTEGER,
  ADD COLUMN "packageHeightMm" INTEGER,
  ADD COLUMN "volumetricWeightGrams" INTEGER,
  ADD COLUMN "productDescription" TEXT,
  ADD COLUMN "hsnCode" TEXT,
  ADD COLUMN "itemCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "tags" JSONB,
  ADD COLUMN "codRiskScore" INTEGER,
  ADD COLUMN "codRiskLevel" TEXT,
  ADD COLUMN "rtoRiskScore" INTEGER,
  ADD COLUMN "rtoRiskLevel" TEXT,
  ADD COLUMN "courierOverride" TEXT,
  ADD COLUMN "addressQualityScore" INTEGER,
  ADD COLUMN "addressQualityFlags" JSONB,
  ADD COLUMN "needsAttentionReasons" JSONB,
  ADD COLUMN "sellerNotes" TEXT,
  ADD COLUMN "pickupLocationId" TEXT;

CREATE TABLE "OrderImportBatch" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "totalRows" INTEGER NOT NULL DEFAULT 0,
  "importedRows" INTEGER NOT NULL DEFAULT 0,
  "skippedRows" INTEGER NOT NULL DEFAULT 0,
  "failedRows" INTEGER NOT NULL DEFAULT 0,
  "errorsJson" JSONB,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OrderImportBatch_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_importBatchId_fkey"
  FOREIGN KEY ("importBatchId") REFERENCES "OrderImportBatch"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_pickupLocationId_fkey"
  FOREIGN KEY ("pickupLocationId") REFERENCES "pickup_locations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderImportBatch"
  ADD CONSTRAINT "OrderImportBatch_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Order_merchantId_source_idx" ON "Order"("merchantId", "source");
CREATE INDEX "Order_merchantId_importBatchId_idx" ON "Order"("merchantId", "importBatchId");
CREATE INDEX "Order_merchantId_pickupLocationId_idx" ON "Order"("merchantId", "pickupLocationId");
CREATE INDEX "OrderImportBatch_merchantId_idx" ON "OrderImportBatch"("merchantId");
CREATE INDEX "OrderImportBatch_merchantId_status_idx" ON "OrderImportBatch"("merchantId", "status");
CREATE INDEX "OrderImportBatch_merchantId_createdAt_idx" ON "OrderImportBatch"("merchantId", "createdAt");
