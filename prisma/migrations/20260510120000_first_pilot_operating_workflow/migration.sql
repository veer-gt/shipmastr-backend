ALTER TABLE "public"."CourierPartner"
  ADD COLUMN "bookingMode" TEXT NOT NULL DEFAULT 'manual';

CREATE TABLE "public"."CourierServiceablePincode" (
  "id" TEXT NOT NULL,
  "courierId" TEXT NOT NULL,
  "pincode" TEXT NOT NULL,
  "supportsPickup" BOOLEAN NOT NULL DEFAULT true,
  "supportsDelivery" BOOLEAN NOT NULL DEFAULT true,
  "supportsCOD" BOOLEAN NOT NULL DEFAULT true,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourierServiceablePincode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierPilotChecklistItem" (
  "id" TEXT NOT NULL,
  "courierId" TEXT NOT NULL,
  "itemKey" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "status" "public"."CourierSandboxVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "owner" TEXT,
  "notes" TEXT,
  "evidenceUrl" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "verifiedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourierPilotChecklistItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."CourierShipment"
  ADD COLUMN "firstShipmentRequestId" TEXT,
  ADD COLUMN "freightEstimate" INTEGER,
  ADD COLUMN "trackingUrl" TEXT,
  ADD COLUMN "opsNotes" TEXT;

ALTER TABLE "public"."FirstShipmentRequest"
  ADD COLUMN "assignedCourierId" TEXT,
  ADD COLUMN "freightEstimate" INTEGER,
  ADD COLUMN "trackingUrl" TEXT,
  ADD COLUMN "opsNotes" TEXT,
  ADD COLUMN "adminApprovedAt" TIMESTAMP(3),
  ADD COLUMN "adminApprovedBy" TEXT;

CREATE UNIQUE INDEX "CourierServiceablePincode_courierId_pincode_key" ON "public"."CourierServiceablePincode"("courierId", "pincode");
CREATE INDEX "CourierServiceablePincode_courierId_idx" ON "public"."CourierServiceablePincode"("courierId");
CREATE INDEX "CourierServiceablePincode_pincode_idx" ON "public"."CourierServiceablePincode"("pincode");
CREATE INDEX "CourierServiceablePincode_active_idx" ON "public"."CourierServiceablePincode"("active");

CREATE UNIQUE INDEX "CourierPilotChecklistItem_courierId_itemKey_key" ON "public"."CourierPilotChecklistItem"("courierId", "itemKey");
CREATE INDEX "CourierPilotChecklistItem_courierId_idx" ON "public"."CourierPilotChecklistItem"("courierId");
CREATE INDEX "CourierPilotChecklistItem_status_idx" ON "public"."CourierPilotChecklistItem"("status");
CREATE INDEX "CourierPilotChecklistItem_verifiedBy_idx" ON "public"."CourierPilotChecklistItem"("verifiedBy");

CREATE INDEX "CourierPartner_bookingMode_idx" ON "public"."CourierPartner"("bookingMode");
CREATE UNIQUE INDEX "CourierShipment_firstShipmentRequestId_key" ON "public"."CourierShipment"("firstShipmentRequestId");
CREATE INDEX "CourierShipment_firstShipmentRequestId_idx" ON "public"."CourierShipment"("firstShipmentRequestId");
CREATE INDEX "FirstShipmentRequest_assignedCourierId_idx" ON "public"."FirstShipmentRequest"("assignedCourierId");
CREATE INDEX "FirstShipmentRequest_adminApprovedAt_idx" ON "public"."FirstShipmentRequest"("adminApprovedAt");

ALTER TABLE "public"."CourierServiceablePincode"
  ADD CONSTRAINT "CourierServiceablePincode_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."CourierPilotChecklistItem"
  ADD CONSTRAINT "CourierPilotChecklistItem_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."CourierShipment"
  ADD CONSTRAINT "CourierShipment_firstShipmentRequestId_fkey" FOREIGN KEY ("firstShipmentRequestId") REFERENCES "public"."FirstShipmentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
