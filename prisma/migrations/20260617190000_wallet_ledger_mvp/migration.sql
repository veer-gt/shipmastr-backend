-- Phase: Wallet ledger MVP
-- Additive hardening for the existing SellerWalletLedger table.

ALTER TABLE "public"."SellerWalletLedger"
ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'POSTED',
ADD COLUMN "balanceBefore" DECIMAL(12, 2),
ADD COLUMN "referenceType" TEXT,
ADD COLUMN "referenceId" TEXT,
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "description" TEXT,
ADD COLUMN "createdBy" TEXT,
ADD COLUMN "postedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "reversedByLedgerId" TEXT,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "SellerWalletLedger_status_idx" ON "public"."SellerWalletLedger"("status");
CREATE INDEX "SellerWalletLedger_referenceType_referenceId_idx" ON "public"."SellerWalletLedger"("referenceType", "referenceId");
CREATE UNIQUE INDEX "SellerWalletLedger_merchantId_idempotencyKey_key" ON "public"."SellerWalletLedger"("merchantId", "idempotencyKey");
