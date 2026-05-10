CREATE TYPE "SellerKycStatus" AS ENUM (
  'NOT_STARTED',
  'DETAILS_SUBMITTED',
  'UNDER_REVIEW',
  'VERIFIED',
  'REJECTED',
  'REOPENED'
);

ALTER TABLE "Merchant"
  ADD COLUMN "panEncrypted" TEXT,
  ADD COLUMN "panIv" TEXT,
  ADD COLUMN "panAuthTag" TEXT,
  ADD COLUMN "panMasked" TEXT,
  ADD COLUMN "sellerKycStatus" "SellerKycStatus" NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN "sellerKycChecklist" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "sellerKycNotes" TEXT,
  ADD COLUMN "sellerKycReviewedAt" TIMESTAMP(3),
  ADD COLUMN "sellerKycReviewedBy" TEXT;

CREATE INDEX "Merchant_panMasked_idx" ON "Merchant"("panMasked");
CREATE INDEX "Merchant_sellerKycStatus_idx" ON "Merchant"("sellerKycStatus");
