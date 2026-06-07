-- Phase 16: WooCommerce Native Order Import + Tracking Sync Foundation
-- Additive WooCommerce connection metadata only. No consumer key/secret storage.

CREATE TYPE "WooCommerceInstallMode" AS ENUM ('REST_KEY_PLACEHOLDER', 'PLUGIN_PLACEHOLDER');
CREATE TYPE "WooCommerceWebhookStatus" AS ENUM ('NOT_CONFIGURED', 'SIMULATED', 'ACTIVE_PLACEHOLDER', 'DISABLED', 'ERROR');

CREATE TABLE "woocommerce_connection_states" (
  "id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "site_url" TEXT NOT NULL,
  "api_version" TEXT,
  "install_mode" "WooCommerceInstallMode" NOT NULL DEFAULT 'REST_KEY_PLACEHOLDER',
  "webhook_status" "WooCommerceWebhookStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "last_webhook_received_at" TIMESTAMP(3),
  "last_order_webhook_id" TEXT,
  "last_tracking_sync_attempt_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "woocommerce_connection_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "woocommerce_connection_states_connection_id_key" ON "woocommerce_connection_states"("connection_id");
CREATE INDEX "woocommerce_connection_states_site_url_idx" ON "woocommerce_connection_states"("site_url");
CREATE INDEX "woocommerce_connection_states_webhook_status_idx" ON "woocommerce_connection_states"("webhook_status");
