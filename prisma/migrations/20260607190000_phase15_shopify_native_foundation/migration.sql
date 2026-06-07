-- Phase 15: Shopify Native Order Import + Fulfillment Sync Foundation
-- Additive Shopify connection metadata only. No token storage.

CREATE TYPE "ShopifyInstallMode" AS ENUM ('CUSTOM_APP', 'PUBLIC_APP_PLACEHOLDER');
CREATE TYPE "ShopifyWebhookStatus" AS ENUM ('NOT_CONFIGURED', 'SIMULATED', 'ACTIVE_PLACEHOLDER', 'DISABLED', 'ERROR');

CREATE TABLE "shopify_connection_states" (
  "id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "shop_domain" TEXT NOT NULL,
  "api_version" TEXT,
  "install_mode" "ShopifyInstallMode" NOT NULL DEFAULT 'CUSTOM_APP',
  "webhook_status" "ShopifyWebhookStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "last_webhook_received_at" TIMESTAMP(3),
  "last_order_webhook_id" TEXT,
  "last_fulfillment_sync_attempt_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shopify_connection_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shopify_connection_states_connection_id_key" ON "shopify_connection_states"("connection_id");
CREATE INDEX "shopify_connection_states_shop_domain_idx" ON "shopify_connection_states"("shop_domain");
CREATE INDEX "shopify_connection_states_webhook_status_idx" ON "shopify_connection_states"("webhook_status");
