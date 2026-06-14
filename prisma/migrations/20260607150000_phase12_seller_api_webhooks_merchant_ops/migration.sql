-- Phase 12: Seller API + Webhooks + Merchant Operations Foundation
-- Additive credential, webhook subscription, and webhook outbox tables only.

CREATE TYPE "SellerApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');
CREATE TYPE "WebhookSubscriptionStatus" AS ENUM ('ACTIVE', 'DISABLED', 'FAILING');
CREATE TYPE "WebhookEventOutboxStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'SKIPPED');

CREATE TABLE "seller_api_keys" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "key_prefix" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "status" "SellerApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
  "last_used_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "seller_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_subscriptions" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "description" TEXT,
  "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "status" "WebhookSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
  "secret_hash" TEXT,
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "last_delivered_at" TIMESTAMP(3),
  "last_failed_at" TIMESTAMP(3),
  "disabled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_event_outbox" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "subscription_id" TEXT,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "WebhookEventOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "last_attempt_at" TIMESTAMP(3),
  "delivered_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_event_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "seller_api_keys_key_hash_key" ON "seller_api_keys"("key_hash");
CREATE INDEX "seller_api_keys_merchant_id_status_idx" ON "seller_api_keys"("merchant_id", "status");
CREATE INDEX "seller_api_keys_key_prefix_idx" ON "seller_api_keys"("key_prefix");
CREATE INDEX "seller_api_keys_expires_at_idx" ON "seller_api_keys"("expires_at");
CREATE INDEX "webhook_subscriptions_merchant_id_status_idx" ON "webhook_subscriptions"("merchant_id", "status");
CREATE INDEX "webhook_subscriptions_merchant_id_created_at_idx" ON "webhook_subscriptions"("merchant_id", "created_at");
CREATE INDEX "webhook_event_outbox_merchant_id_status_idx" ON "webhook_event_outbox"("merchant_id", "status");
CREATE INDEX "webhook_event_outbox_merchant_id_event_type_idx" ON "webhook_event_outbox"("merchant_id", "event_type");
CREATE INDEX "webhook_event_outbox_subscription_id_idx" ON "webhook_event_outbox"("subscription_id");
CREATE INDEX "webhook_event_outbox_created_at_idx" ON "webhook_event_outbox"("created_at");
