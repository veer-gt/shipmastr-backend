-- Add explicit seller/merchant pickup and warehouse pin confirmation metadata.
ALTER TABLE "MerchantPickupPoint"
  ADD COLUMN "pinLatitude" DECIMAL(10, 7),
  ADD COLUMN "pinLongitude" DECIMAL(10, 7),
  ADD COLUMN "pinConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "pinSource" TEXT,
  ADD COLUMN "pinLabel" TEXT,
  ADD COLUMN "pinUpdatedAt" TIMESTAMP(3);

ALTER TABLE "MerchantWarehouse"
  ADD COLUMN "pinLatitude" DECIMAL(10, 7),
  ADD COLUMN "pinLongitude" DECIMAL(10, 7),
  ADD COLUMN "pinConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "pinSource" TEXT,
  ADD COLUMN "pinLabel" TEXT,
  ADD COLUMN "pinUpdatedAt" TIMESTAMP(3);
