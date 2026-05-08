CREATE TYPE "MerchantAdminStatus" AS ENUM ('NEW', 'ONBOARDING', 'READY_TO_SHIP', 'BLOCKED');

ALTER TABLE "Merchant"
  ADD COLUMN "adminStatus" "MerchantAdminStatus" NOT NULL DEFAULT 'NEW',
  ADD COLUMN "adminNotes" TEXT;

CREATE INDEX "Merchant_adminStatus_idx" ON "Merchant"("adminStatus");
CREATE INDEX "Merchant_onboardingStatus_idx" ON "Merchant"("onboardingStatus");
