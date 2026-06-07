-- Phase 14: Shopify/WooCommerce/Magento Adapter Foundation
-- Additive platform connection, order import, and tracking sync foundation only.

CREATE TYPE "StorePlatform" AS ENUM ('SHOPIFY', 'WOOCOMMERCE', 'MAGENTO', 'CUSTOM');
CREATE TYPE "PlatformConnectionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED', 'ERROR');
CREATE TYPE "PlatformSyncDirection" AS ENUM ('IMPORT_ONLY', 'EXPORT_ONLY', 'BIDIRECTIONAL');
CREATE TYPE "PlatformOrderImportStatus" AS ENUM ('RECEIVED', 'MAPPED', 'SKIPPED', 'FAILED', 'IMPORTED');
CREATE TYPE "PlatformTrackingSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED', 'SKIPPED');

CREATE TABLE "platform_connections" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "platform" "StorePlatform" NOT NULL,
  "store_name" TEXT,
  "store_url" TEXT NOT NULL,
  "status" "PlatformConnectionStatus" NOT NULL DEFAULT 'DRAFT',
  "sync_direction" "PlatformSyncDirection" NOT NULL DEFAULT 'IMPORT_ONLY',
  "credentials_ref" TEXT,
  "credentials_meta" JSONB,
  "last_order_import_at" TIMESTAMP(3),
  "last_tracking_sync_at" TIMESTAMP(3),
  "last_error_code" TEXT,
  "last_error_message" TEXT,
  "disabled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_order_imports" (
  "id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "platform" "StorePlatform" NOT NULL,
  "external_order_id" TEXT NOT NULL,
  "external_order_name" TEXT,
  "status" "PlatformOrderImportStatus" NOT NULL DEFAULT 'RECEIVED',
  "normalized_order_id" TEXT,
  "raw_payload_hash" TEXT,
  "raw_payload_preview" JSONB,
  "mapping_warnings" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_order_imports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_tracking_syncs" (
  "id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "shipment_id" TEXT NOT NULL,
  "platform" "StorePlatform" NOT NULL,
  "external_order_id" TEXT,
  "tracking_number" TEXT,
  "tracking_url" TEXT,
  "status" "PlatformTrackingSyncStatus" NOT NULL DEFAULT 'PENDING',
  "last_attempt_at" TIMESTAMP(3),
  "synced_at" TIMESTAMP(3),
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_tracking_syncs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_connections_merchant_id_status_idx" ON "platform_connections"("merchant_id", "status");
CREATE INDEX "platform_connections_merchant_id_platform_idx" ON "platform_connections"("merchant_id", "platform");
CREATE INDEX "platform_connections_merchant_id_created_at_idx" ON "platform_connections"("merchant_id", "created_at");
CREATE INDEX "platform_order_imports_merchant_id_status_idx" ON "platform_order_imports"("merchant_id", "status");
CREATE INDEX "platform_order_imports_connection_id_idx" ON "platform_order_imports"("connection_id");
CREATE INDEX "platform_order_imports_merchant_id_platform_idx" ON "platform_order_imports"("merchant_id", "platform");
CREATE INDEX "platform_order_imports_merchant_id_external_order_id_idx" ON "platform_order_imports"("merchant_id", "external_order_id");
CREATE INDEX "platform_order_imports_created_at_idx" ON "platform_order_imports"("created_at");
CREATE INDEX "platform_tracking_syncs_merchant_id_status_idx" ON "platform_tracking_syncs"("merchant_id", "status");
CREATE INDEX "platform_tracking_syncs_connection_id_idx" ON "platform_tracking_syncs"("connection_id");
CREATE INDEX "platform_tracking_syncs_shipment_id_idx" ON "platform_tracking_syncs"("shipment_id");
CREATE INDEX "platform_tracking_syncs_merchant_id_external_order_id_idx" ON "platform_tracking_syncs"("merchant_id", "external_order_id");
