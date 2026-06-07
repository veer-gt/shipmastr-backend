CREATE TYPE "MagentoInstallMode" AS ENUM ('INTEGRATION_TOKEN_PLACEHOLDER', 'EXTENSION_PLACEHOLDER', 'ADOBE_COMMERCE_PLACEHOLDER');

CREATE TYPE "MagentoWebhookStatus" AS ENUM ('NOT_CONFIGURED', 'SIMULATED', 'ACTIVE_PLACEHOLDER', 'DISABLED', 'ERROR');

CREATE TABLE "magento_connection_states" (
  "id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "base_url" TEXT NOT NULL,
  "store_view_code" TEXT,
  "website_code" TEXT,
  "api_version" TEXT,
  "install_mode" "MagentoInstallMode" NOT NULL DEFAULT 'INTEGRATION_TOKEN_PLACEHOLDER',
  "webhook_status" "MagentoWebhookStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "last_webhook_received_at" TIMESTAMP(3),
  "last_order_webhook_id" TEXT,
  "last_shipping_sync_attempt_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "magento_connection_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "magento_connection_states_connection_id_key" ON "magento_connection_states"("connection_id");
CREATE INDEX "magento_connection_states_base_url_idx" ON "magento_connection_states"("base_url");
CREATE INDEX "magento_connection_states_store_view_code_idx" ON "magento_connection_states"("store_view_code");
CREATE INDEX "magento_connection_states_webhook_status_idx" ON "magento_connection_states"("webhook_status");
