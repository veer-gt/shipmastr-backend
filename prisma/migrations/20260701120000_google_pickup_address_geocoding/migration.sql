CREATE TYPE "AddressGeocodeStatus" AS ENUM (
  'PENDING',
  'GEOCODED',
  'LOW_CONFIDENCE',
  'FAILED',
  'SKIPPED'
);

ALTER TABLE "MerchantPickupPoint"
  ADD COLUMN "latitude" DECIMAL(10, 7),
  ADD COLUMN "longitude" DECIMAL(10, 7),
  ADD COLUMN "googleGeocodePlaceId" TEXT,
  ADD COLUMN "googleFormattedAddress" TEXT,
  ADD COLUMN "geocodeProvider" TEXT,
  ADD COLUMN "geocodeStatus" "AddressGeocodeStatus" NOT NULL DEFAULT 'SKIPPED',
  ADD COLUMN "geocodeLocationType" TEXT,
  ADD COLUMN "geocodePartialMatch" BOOLEAN,
  ADD COLUMN "geocodeErrorCode" TEXT,
  ADD COLUMN "geocodedAt" TIMESTAMP(3),
  ADD COLUMN "addressFingerprint" TEXT;

ALTER TABLE "MerchantWarehouse"
  ADD COLUMN "latitude" DECIMAL(10, 7),
  ADD COLUMN "longitude" DECIMAL(10, 7),
  ADD COLUMN "googleGeocodePlaceId" TEXT,
  ADD COLUMN "googleFormattedAddress" TEXT,
  ADD COLUMN "geocodeProvider" TEXT,
  ADD COLUMN "geocodeStatus" "AddressGeocodeStatus" NOT NULL DEFAULT 'SKIPPED',
  ADD COLUMN "geocodeLocationType" TEXT,
  ADD COLUMN "geocodePartialMatch" BOOLEAN,
  ADD COLUMN "geocodeErrorCode" TEXT,
  ADD COLUMN "geocodedAt" TIMESTAMP(3),
  ADD COLUMN "addressFingerprint" TEXT;

CREATE TABLE "AddressGeocodeTask" (
  "id" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "addressFingerprint" TEXT NOT NULL,
  "status" "AddressGeocodeStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" TEXT,
  "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AddressGeocodeTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GoogleMapsUsageCounter" (
  "id" TEXT NOT NULL,
  "service" TEXT NOT NULL,
  "yearMonth" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "softLimit" INTEGER NOT NULL,
  "hardLimit" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GoogleMapsUsageCounter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AddressGeocodeTask_entityType_entityId_addressFingerprint_key"
  ON "AddressGeocodeTask"("entityType", "entityId", "addressFingerprint");
CREATE INDEX "AddressGeocodeTask_status_runAfter_idx"
  ON "AddressGeocodeTask"("status", "runAfter");
CREATE INDEX "AddressGeocodeTask_merchantId_idx"
  ON "AddressGeocodeTask"("merchantId");

CREATE UNIQUE INDEX "GoogleMapsUsageCounter_service_yearMonth_key"
  ON "GoogleMapsUsageCounter"("service", "yearMonth");
CREATE INDEX "GoogleMapsUsageCounter_yearMonth_idx"
  ON "GoogleMapsUsageCounter"("yearMonth");

CREATE INDEX "MerchantPickupPoint_merchantId_geocodeStatus_idx"
  ON "MerchantPickupPoint"("merchantId", "geocodeStatus");
CREATE INDEX "MerchantPickupPoint_addressFingerprint_idx"
  ON "MerchantPickupPoint"("addressFingerprint");
CREATE INDEX "MerchantWarehouse_merchantId_geocodeStatus_idx"
  ON "MerchantWarehouse"("merchantId", "geocodeStatus");
CREATE INDEX "MerchantWarehouse_addressFingerprint_idx"
  ON "MerchantWarehouse"("addressFingerprint");
