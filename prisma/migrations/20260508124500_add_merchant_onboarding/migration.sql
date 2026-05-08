CREATE TYPE "MerchantOnboardingStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'READY_TO_SHIP');

CREATE TYPE "MerchantOnboardingStepStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED');

ALTER TABLE "Merchant"
  ADD COLUMN "onboardingStatus" "MerchantOnboardingStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "pickupAddressStatus" "MerchantOnboardingStepStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "kycStatus" "MerchantOnboardingStepStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "bankStatus" "MerchantOnboardingStepStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "firstShipmentStatus" "MerchantOnboardingStepStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "onboardingNotes" TEXT;
