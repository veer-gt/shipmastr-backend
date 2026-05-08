CREATE TYPE "FirstShipmentRequestStatus" AS ENUM ('NEW', 'REVIEWING', 'APPROVED', 'SCHEDULED', 'COMPLETED', 'CANCELLED');

CREATE TABLE "FirstShipmentRequest" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "requesterUserId" TEXT NOT NULL,
  "pickupName" TEXT NOT NULL,
  "pickupPhone" TEXT NOT NULL,
  "pickupAddress" TEXT NOT NULL,
  "pickupPincode" TEXT NOT NULL,
  "deliveryCity" TEXT NOT NULL,
  "deliveryPincode" TEXT NOT NULL,
  "packageWeight" INTEGER NOT NULL,
  "paymentMode" "PaymentMode" NOT NULL,
  "codAmount" INTEGER NOT NULL DEFAULT 0,
  "notes" TEXT,
  "status" "FirstShipmentRequestStatus" NOT NULL DEFAULT 'NEW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FirstShipmentRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FirstShipmentRequest_merchantId_idx" ON "FirstShipmentRequest"("merchantId");
CREATE INDEX "FirstShipmentRequest_requesterUserId_idx" ON "FirstShipmentRequest"("requesterUserId");
CREATE INDEX "FirstShipmentRequest_status_idx" ON "FirstShipmentRequest"("status");
CREATE INDEX "FirstShipmentRequest_paymentMode_idx" ON "FirstShipmentRequest"("paymentMode");
CREATE INDEX "FirstShipmentRequest_createdAt_idx" ON "FirstShipmentRequest"("createdAt");

ALTER TABLE "FirstShipmentRequest"
  ADD CONSTRAINT "FirstShipmentRequest_merchantId_fkey"
  FOREIGN KEY ("merchantId")
  REFERENCES "Merchant"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "FirstShipmentRequest"
  ADD CONSTRAINT "FirstShipmentRequest_requesterUserId_fkey"
  FOREIGN KEY ("requesterUserId")
  REFERENCES "User"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
