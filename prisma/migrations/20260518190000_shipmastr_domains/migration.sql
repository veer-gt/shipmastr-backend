-- Shipmastr Domains white-label foundation.
-- Provider credentials stay in Secret Manager/env only; these tables store merchant-safe domain state
-- and admin-only provisioning diagnostics.

DO $$ BEGIN
  CREATE TYPE "DomainProvider" AS ENUM ('RESELLERCLUB', 'CLOUDFLARE', 'MANUAL');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "MerchantDomainSource" AS ENUM ('PURCHASED_THROUGH_SHIPMASTR', 'EXTERNAL_CONNECTED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "DomainStatus" AS ENUM (
    'SEARCHED',
    'AVAILABLE',
    'UNAVAILABLE',
    'PAYMENT_REQUIRED',
    'APPROVAL_REQUIRED',
    'REGISTERING',
    'REGISTERED',
    'DNS_PENDING',
    'CLOUDFLARE_PENDING',
    'SSL_PENDING',
    'ACTIVE',
    'FAILED',
    'SUSPENDED',
    'EXPIRED',
    'RENEWAL_DUE'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "DomainProvisioningStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'SKIPPED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "DomainProduct" (
  "id" TEXT NOT NULL,
  "tld" TEXT NOT NULL,
  "provider" "DomainProvider" NOT NULL DEFAULT 'RESELLERCLUB',
  "registrationPricePaise" INTEGER NOT NULL,
  "renewalPricePaise" INTEGER NOT NULL,
  "transferPricePaise" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DomainProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MerchantDomain" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "storefrontId" TEXT,
  "domain" TEXT NOT NULL,
  "normalizedDomain" TEXT NOT NULL,
  "source" "MerchantDomainSource" NOT NULL,
  "provider" "DomainProvider" NOT NULL DEFAULT 'RESELLERCLUB',
  "status" "DomainStatus" NOT NULL DEFAULT 'SEARCHED',
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "resellerClubEntityId" TEXT,
  "resellerClubOrderId" TEXT,
  "cloudflareCustomHostnameId" TEXT,
  "sslStatus" TEXT,
  "validationRecords" JSONB,
  "expiresAt" TIMESTAMP(3),
  "autoRenew" BOOLEAN NOT NULL DEFAULT true,
  "lastCheckedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchantDomain_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DomainProvisioningEvent" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT,
  "merchantDomainId" TEXT,
  "storefrontId" TEXT,
  "provider" "DomainProvider" NOT NULL,
  "eventType" TEXT NOT NULL,
  "status" "DomainProvisioningStatus" NOT NULL,
  "requestPayload" JSONB,
  "responsePayload" JSONB,
  "safeMessage" TEXT,
  "internalError" TEXT,
  "providerReferenceId" TEXT,
  "idempotencyKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DomainProvisioningEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DomainProduct_tld_provider_key" ON "DomainProduct"("tld", "provider");
CREATE INDEX IF NOT EXISTS "DomainProduct_provider_idx" ON "DomainProduct"("provider");
CREATE INDEX IF NOT EXISTS "DomainProduct_isActive_idx" ON "DomainProduct"("isActive");

CREATE UNIQUE INDEX IF NOT EXISTS "MerchantDomain_normalizedDomain_key" ON "MerchantDomain"("normalizedDomain");
CREATE INDEX IF NOT EXISTS "MerchantDomain_merchantId_idx" ON "MerchantDomain"("merchantId");
CREATE INDEX IF NOT EXISTS "MerchantDomain_storefrontId_idx" ON "MerchantDomain"("storefrontId");
CREATE INDEX IF NOT EXISTS "MerchantDomain_status_idx" ON "MerchantDomain"("status");
CREATE INDEX IF NOT EXISTS "MerchantDomain_provider_idx" ON "MerchantDomain"("provider");
CREATE INDEX IF NOT EXISTS "MerchantDomain_resellerClubEntityId_idx" ON "MerchantDomain"("resellerClubEntityId");
CREATE INDEX IF NOT EXISTS "MerchantDomain_cloudflareCustomHostnameId_idx" ON "MerchantDomain"("cloudflareCustomHostnameId");
CREATE INDEX IF NOT EXISTS "MerchantDomain_expiresAt_idx" ON "MerchantDomain"("expiresAt");
CREATE INDEX IF NOT EXISTS "MerchantDomain_createdAt_idx" ON "MerchantDomain"("createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "DomainProvisioningEvent_idempotencyKey_key" ON "DomainProvisioningEvent"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "DomainProvisioningEvent_merchantId_idx" ON "DomainProvisioningEvent"("merchantId");
CREATE INDEX IF NOT EXISTS "DomainProvisioningEvent_merchantDomainId_idx" ON "DomainProvisioningEvent"("merchantDomainId");
CREATE INDEX IF NOT EXISTS "DomainProvisioningEvent_storefrontId_idx" ON "DomainProvisioningEvent"("storefrontId");
CREATE INDEX IF NOT EXISTS "DomainProvisioningEvent_provider_idx" ON "DomainProvisioningEvent"("provider");
CREATE INDEX IF NOT EXISTS "DomainProvisioningEvent_eventType_idx" ON "DomainProvisioningEvent"("eventType");
CREATE INDEX IF NOT EXISTS "DomainProvisioningEvent_status_idx" ON "DomainProvisioningEvent"("status");
CREATE INDEX IF NOT EXISTS "DomainProvisioningEvent_providerReferenceId_idx" ON "DomainProvisioningEvent"("providerReferenceId");
CREATE INDEX IF NOT EXISTS "DomainProvisioningEvent_createdAt_idx" ON "DomainProvisioningEvent"("createdAt");

DO $$ BEGIN
  ALTER TABLE "MerchantDomain"
    ADD CONSTRAINT "MerchantDomain_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DomainProvisioningEvent"
    ADD CONSTRAINT "DomainProvisioningEvent_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DomainProvisioningEvent"
    ADD CONSTRAINT "DomainProvisioningEvent_merchantDomainId_fkey"
    FOREIGN KEY ("merchantDomainId") REFERENCES "MerchantDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
