-- Phase 3 storefront renderer persistence.
-- Additive only: no production DNS/provider automation, no destructive changes.

ALTER TYPE "DomainStatus" ADD VALUE IF NOT EXISTS 'REQUESTED';

CREATE TABLE IF NOT EXISTS "Storefront" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Storefront_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StorefrontDomain" (
  "id" TEXT NOT NULL,
  "storefrontId" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "status" "DomainStatus" NOT NULL DEFAULT 'REQUESTED',
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "verificationStatus" TEXT,
  "dnsTarget" TEXT,
  "cloudflareCustomHostnameId" TEXT,
  "sslStatus" TEXT,
  "failureReason" TEXT,
  "lastCheckedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontDomain_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StorefrontSettings" (
  "id" TEXT NOT NULL,
  "storefrontId" TEXT NOT NULL,
  "themeJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontSettings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DomainProvisioningEvent"
  ADD COLUMN IF NOT EXISTS "storefrontDomainId" TEXT,
  ADD COLUMN IF NOT EXISTS "payload" JSONB;

CREATE INDEX IF NOT EXISTS "Storefront_merchantId_idx" ON "Storefront"("merchantId");

CREATE UNIQUE INDEX IF NOT EXISTS "StorefrontDomain_domain_key" ON "StorefrontDomain"("domain");
CREATE INDEX IF NOT EXISTS "StorefrontDomain_storefrontId_idx" ON "StorefrontDomain"("storefrontId");
CREATE INDEX IF NOT EXISTS "StorefrontDomain_status_idx" ON "StorefrontDomain"("status");

CREATE UNIQUE INDEX IF NOT EXISTS "StorefrontSettings_storefrontId_key" ON "StorefrontSettings"("storefrontId");

CREATE INDEX IF NOT EXISTS "DomainProvisioningEvent_storefrontDomainId_idx" ON "DomainProvisioningEvent"("storefrontDomainId");

DO $$ BEGIN
  ALTER TABLE "Storefront"
    ADD CONSTRAINT "Storefront_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "StorefrontDomain"
    ADD CONSTRAINT "StorefrontDomain_storefrontId_fkey"
    FOREIGN KEY ("storefrontId") REFERENCES "Storefront"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "StorefrontSettings"
    ADD CONSTRAINT "StorefrontSettings_storefrontId_fkey"
    FOREIGN KEY ("storefrontId") REFERENCES "Storefront"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DomainProvisioningEvent"
    ADD CONSTRAINT "DomainProvisioningEvent_storefrontDomainId_fkey"
    FOREIGN KEY ("storefrontDomainId") REFERENCES "StorefrontDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
