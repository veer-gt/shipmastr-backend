-- Merchant-owned operational setup persistence for staging-first CRUD workspaces.
-- No provider, courier, messaging, or external-action relations are introduced here.

CREATE TABLE "MerchantWarehouse" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "notes" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantWarehouse_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MerchantCustomer" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantCustomer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MerchantWarehouse_merchantId_idx" ON "MerchantWarehouse"("merchantId");
CREATE INDEX "MerchantWarehouse_merchantId_isPrimary_idx" ON "MerchantWarehouse"("merchantId", "isPrimary");
CREATE INDEX "MerchantWarehouse_merchantId_isActive_idx" ON "MerchantWarehouse"("merchantId", "isActive");
CREATE INDEX "MerchantWarehouse_merchantId_pincode_idx" ON "MerchantWarehouse"("merchantId", "pincode");

CREATE INDEX "MerchantCustomer_merchantId_idx" ON "MerchantCustomer"("merchantId");
CREATE INDEX "MerchantCustomer_merchantId_isActive_idx" ON "MerchantCustomer"("merchantId", "isActive");
CREATE INDEX "MerchantCustomer_merchantId_phone_idx" ON "MerchantCustomer"("merchantId", "phone");
CREATE INDEX "MerchantCustomer_merchantId_pincode_idx" ON "MerchantCustomer"("merchantId", "pincode");

ALTER TABLE "MerchantWarehouse"
  ADD CONSTRAINT "MerchantWarehouse_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MerchantCustomer"
  ADD CONSTRAINT "MerchantCustomer_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
