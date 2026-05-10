CREATE TYPE "FirstShipmentRequestStatus_new" AS ENUM (
  'NEW',
  'REVIEWING',
  'READY_TO_BOOK',
  'BOOKED_MANUALLY',
  'AWB_ADDED',
  'PICKED_UP',
  'IN_TRANSIT',
  'DELIVERED',
  'NDR',
  'RTO',
  'CANCELLED'
);

ALTER TABLE "FirstShipmentRequest" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "FirstShipmentRequest"
  ALTER COLUMN "status" TYPE "FirstShipmentRequestStatus_new"
  USING (
    CASE "status"::text
      WHEN 'APPROVED' THEN 'READY_TO_BOOK'
      WHEN 'SCHEDULED' THEN 'BOOKED_MANUALLY'
      WHEN 'COMPLETED' THEN 'DELIVERED'
      ELSE "status"::text
    END
  )::"FirstShipmentRequestStatus_new";

ALTER TABLE "FirstShipmentRequest" ALTER COLUMN "status" SET DEFAULT 'NEW';

DROP TYPE "FirstShipmentRequestStatus";
ALTER TYPE "FirstShipmentRequestStatus_new" RENAME TO "FirstShipmentRequestStatus";

ALTER TABLE "FirstShipmentRequest"
  ADD COLUMN "buyerName" TEXT,
  ADD COLUMN "buyerPhone" TEXT,
  ADD COLUMN "buyerAddress" TEXT,
  ADD COLUMN "packageDescription" TEXT,
  ADD COLUMN "courierPreference" TEXT,
  ADD COLUMN "awb" TEXT,
  ADD COLUMN "trackingNumber" TEXT;

CREATE INDEX "FirstShipmentRequest_awb_idx" ON "FirstShipmentRequest"("awb");
CREATE INDEX "FirstShipmentRequest_trackingNumber_idx" ON "FirstShipmentRequest"("trackingNumber");
