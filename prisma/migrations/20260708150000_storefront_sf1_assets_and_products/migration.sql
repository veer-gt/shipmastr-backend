-- SF1: storefront asset registry (GCS-backed, themeJson stores references only)
-- SF5 Layer 3: server-authoritative storefront product catalog (real priceMinor)
-- Additive only.

DO $$ BEGIN
  CREATE TYPE "StorefrontAssetStatus" AS ENUM ('PENDING', 'READY', 'DELETED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "StorefrontAsset" (
  "id"         TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "gcsPath"    TEXT NOT NULL,
  "mime"       TEXT NOT NULL,
  "bytes"      INTEGER,
  "width"      INTEGER,
  "height"     INTEGER,
  "sha256"     TEXT,
  "status"     "StorefrontAssetStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StorefrontProduct" (
  "id"           TEXT NOT NULL,
  "storefrontId" TEXT NOT NULL,
  "merchantId"   TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "priceMinor"   INTEGER NOT NULL,
  "currency"     TEXT NOT NULL DEFAULT 'INR',
  "description"  TEXT,
  "imageAssetId" TEXT,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontProduct_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StorefrontAsset_gcsPath_key" ON "StorefrontAsset"("gcsPath");
CREATE INDEX IF NOT EXISTS "StorefrontAsset_merchantId_idx" ON "StorefrontAsset"("merchantId");
CREATE INDEX IF NOT EXISTS "StorefrontAsset_status_idx" ON "StorefrontAsset"("status");
CREATE INDEX IF NOT EXISTS "StorefrontAsset_sha256_idx" ON "StorefrontAsset"("sha256");

CREATE INDEX IF NOT EXISTS "StorefrontProduct_storefrontId_idx" ON "StorefrontProduct"("storefrontId");
CREATE INDEX IF NOT EXISTS "StorefrontProduct_merchantId_idx" ON "StorefrontProduct"("merchantId");
CREATE INDEX IF NOT EXISTS "StorefrontProduct_imageAssetId_idx" ON "StorefrontProduct"("imageAssetId");

DO $$ BEGIN
  ALTER TABLE "StorefrontAsset"
    ADD CONSTRAINT "StorefrontAsset_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "StorefrontProduct"
    ADD CONSTRAINT "StorefrontProduct_storefrontId_fkey"
    FOREIGN KEY ("storefrontId") REFERENCES "Storefront"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "StorefrontProduct"
    ADD CONSTRAINT "StorefrontProduct_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "StorefrontProduct"
    ADD CONSTRAINT "StorefrontProduct_imageAssetId_fkey"
    FOREIGN KEY ("imageAssetId") REFERENCES "StorefrontAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
