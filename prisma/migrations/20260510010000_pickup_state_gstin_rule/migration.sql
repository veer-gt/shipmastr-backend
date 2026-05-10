CREATE TYPE "AccountGstinVerificationStatus" AS ENUM (
  'PENDING',
  'VERIFIED',
  'REJECTED'
);

CREATE TYPE "PickupPointStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'REQUIRE_STATE_GSTIN',
  'BLOCKED'
);

CREATE TABLE "MerchantGstinRecord" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "gstin" TEXT NOT NULL,
  "legalName" TEXT,
  "tradeName" TEXT,
  "registrationStatus" TEXT,
  "registeredAddress" TEXT,
  "registeredState" TEXT NOT NULL,
  "registeredPincode" TEXT,
  "verificationStatus" "AccountGstinVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "verifiedAt" TIMESTAMP(3),
  "verifiedBy" TEXT,
  "rejectedAt" TIMESTAMP(3),
  "rejectedBy" TEXT,
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchantGstinRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MerchantPickupPoint" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "linkedGstinId" TEXT,
  "label" TEXT NOT NULL,
  "contactName" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "addressLine1" TEXT NOT NULL,
  "addressLine2" TEXT,
  "city" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "pincode" TEXT NOT NULL,
  "status" "PickupPointStatus" NOT NULL DEFAULT 'PENDING',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "blockerReason" TEXT,
  "approvedAt" TIMESTAMP(3),
  "approvedBy" TEXT,
  "rejectedAt" TIMESTAMP(3),
  "rejectedBy" TEXT,
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchantPickupPoint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourierGstinRecord" (
  "id" TEXT NOT NULL,
  "courierId" TEXT NOT NULL,
  "gstin" TEXT NOT NULL,
  "legalName" TEXT,
  "tradeName" TEXT,
  "registrationStatus" TEXT,
  "registeredAddress" TEXT,
  "registeredState" TEXT NOT NULL,
  "registeredPincode" TEXT,
  "verificationStatus" "AccountGstinVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "verifiedAt" TIMESTAMP(3),
  "verifiedBy" TEXT,
  "rejectedAt" TIMESTAMP(3),
  "rejectedBy" TEXT,
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourierGstinRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourierOperationalLocation" (
  "id" TEXT NOT NULL,
  "courierId" TEXT NOT NULL,
  "linkedGstinId" TEXT,
  "label" TEXT NOT NULL,
  "contactName" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "addressLine1" TEXT NOT NULL,
  "addressLine2" TEXT,
  "city" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "pincode" TEXT NOT NULL,
  "status" "PickupPointStatus" NOT NULL DEFAULT 'PENDING',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "blockerReason" TEXT,
  "approvedAt" TIMESTAMP(3),
  "approvedBy" TEXT,
  "rejectedAt" TIMESTAMP(3),
  "rejectedBy" TEXT,
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourierOperationalLocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MerchantGstinRecord_merchantId_gstin_key" ON "MerchantGstinRecord"("merchantId", "gstin");
CREATE INDEX "MerchantGstinRecord_merchantId_idx" ON "MerchantGstinRecord"("merchantId");
CREATE INDEX "MerchantGstinRecord_registeredState_idx" ON "MerchantGstinRecord"("registeredState");
CREATE INDEX "MerchantGstinRecord_verificationStatus_idx" ON "MerchantGstinRecord"("verificationStatus");
CREATE INDEX "MerchantGstinRecord_merchantId_registeredState_verificationStatus_idx" ON "MerchantGstinRecord"("merchantId", "registeredState", "verificationStatus");

CREATE INDEX "MerchantPickupPoint_merchantId_idx" ON "MerchantPickupPoint"("merchantId");
CREATE INDEX "MerchantPickupPoint_linkedGstinId_idx" ON "MerchantPickupPoint"("linkedGstinId");
CREATE INDEX "MerchantPickupPoint_state_idx" ON "MerchantPickupPoint"("state");
CREATE INDEX "MerchantPickupPoint_status_idx" ON "MerchantPickupPoint"("status");
CREATE INDEX "MerchantPickupPoint_merchantId_state_status_idx" ON "MerchantPickupPoint"("merchantId", "state", "status");
CREATE INDEX "MerchantPickupPoint_merchantId_isDefault_idx" ON "MerchantPickupPoint"("merchantId", "isDefault");

CREATE UNIQUE INDEX "CourierGstinRecord_courierId_gstin_key" ON "CourierGstinRecord"("courierId", "gstin");
CREATE INDEX "CourierGstinRecord_courierId_idx" ON "CourierGstinRecord"("courierId");
CREATE INDEX "CourierGstinRecord_registeredState_idx" ON "CourierGstinRecord"("registeredState");
CREATE INDEX "CourierGstinRecord_verificationStatus_idx" ON "CourierGstinRecord"("verificationStatus");
CREATE INDEX "CourierGstinRecord_courierId_registeredState_verificationStatus_idx" ON "CourierGstinRecord"("courierId", "registeredState", "verificationStatus");

CREATE INDEX "CourierOperationalLocation_courierId_idx" ON "CourierOperationalLocation"("courierId");
CREATE INDEX "CourierOperationalLocation_linkedGstinId_idx" ON "CourierOperationalLocation"("linkedGstinId");
CREATE INDEX "CourierOperationalLocation_state_idx" ON "CourierOperationalLocation"("state");
CREATE INDEX "CourierOperationalLocation_status_idx" ON "CourierOperationalLocation"("status");
CREATE INDEX "CourierOperationalLocation_courierId_state_status_idx" ON "CourierOperationalLocation"("courierId", "state", "status");
CREATE INDEX "CourierOperationalLocation_courierId_isDefault_idx" ON "CourierOperationalLocation"("courierId", "isDefault");

ALTER TABLE "MerchantGstinRecord" ADD CONSTRAINT "MerchantGstinRecord_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchantPickupPoint" ADD CONSTRAINT "MerchantPickupPoint_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchantPickupPoint" ADD CONSTRAINT "MerchantPickupPoint_linkedGstinId_fkey" FOREIGN KEY ("linkedGstinId") REFERENCES "MerchantGstinRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CourierGstinRecord" ADD CONSTRAINT "CourierGstinRecord_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourierOperationalLocation" ADD CONSTRAINT "CourierOperationalLocation_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourierOperationalLocation" ADD CONSTRAINT "CourierOperationalLocation_linkedGstinId_fkey" FOREIGN KEY ("linkedGstinId") REFERENCES "CourierGstinRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
