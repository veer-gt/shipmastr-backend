-- Phase 45B: COD-to-prepaid incentive foundation.
-- Additive only. No payment gateway calls, payment collection, order paid-state mutation, or provider/courier calls.

CREATE TYPE "PrepaidIncentiveStatus" AS ENUM (
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'ARCHIVED'
);

CREATE TYPE "PrepaidIncentiveType" AS ENUM (
  'FLAT_DISCOUNT',
  'PERCENT_DISCOUNT',
  'FREE_SHIPPING',
  'COD_FEE_WAIVER',
  'PRIORITY_DISPATCH'
);

CREATE TYPE "PrepaidConversionIntentStatus" AS ENUM (
  'OFFERED',
  'CLICKED',
  'INTENT_CREATED',
  'PAYMENT_PENDING',
  'CONVERTED_SIMULATED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TABLE "prepaid_incentive_policies" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" "PrepaidIncentiveStatus" NOT NULL DEFAULT 'DRAFT',
  "incentive_type" "PrepaidIncentiveType" NOT NULL,
  "discount_amount_paise" INTEGER,
  "discount_percent" DECIMAL(5,2),
  "max_discount_amount_paise" INTEGER,
  "min_order_amount_paise" INTEGER,
  "max_order_amount_paise" INTEGER,
  "starts_at" TIMESTAMP(3),
  "ends_at" TIMESTAMP(3),
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "prepaid_incentive_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "prepaid_conversion_intents" (
  "id" TEXT NOT NULL,
  "policy_id" TEXT,
  "merchant_id" TEXT,
  "seller_id" TEXT,
  "order_id" TEXT,
  "shipment_id" TEXT,
  "growth_offer_id" TEXT,
  "status" "PrepaidConversionIntentStatus" NOT NULL DEFAULT 'INTENT_CREATED',
  "original_payment_mode" TEXT,
  "target_payment_mode" TEXT NOT NULL DEFAULT 'PREPAID',
  "incentive_snapshot" JSONB NOT NULL,
  "idempotency_key" TEXT,
  "expires_at" TIMESTAMP(3),
  "converted_at" TIMESTAMP(3),
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "prepaid_conversion_intents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "prepaid_incentive_policies_merchant_id_idx" ON "prepaid_incentive_policies"("merchant_id");
CREATE INDEX "prepaid_incentive_policies_status_idx" ON "prepaid_incentive_policies"("status");
CREATE INDEX "prepaid_incentive_policies_incentive_type_idx" ON "prepaid_incentive_policies"("incentive_type");
CREATE INDEX "prepaid_incentive_policies_starts_at_idx" ON "prepaid_incentive_policies"("starts_at");
CREATE INDEX "prepaid_incentive_policies_ends_at_idx" ON "prepaid_incentive_policies"("ends_at");
CREATE INDEX "prepaid_incentive_policies_created_at_idx" ON "prepaid_incentive_policies"("created_at");

CREATE UNIQUE INDEX "prepaid_conversion_intents_idempotency_key_key" ON "prepaid_conversion_intents"("idempotency_key");
CREATE INDEX "prepaid_conversion_intents_policy_id_idx" ON "prepaid_conversion_intents"("policy_id");
CREATE INDEX "prepaid_conversion_intents_merchant_id_idx" ON "prepaid_conversion_intents"("merchant_id");
CREATE INDEX "prepaid_conversion_intents_seller_id_idx" ON "prepaid_conversion_intents"("seller_id");
CREATE INDEX "prepaid_conversion_intents_order_id_idx" ON "prepaid_conversion_intents"("order_id");
CREATE INDEX "prepaid_conversion_intents_shipment_id_idx" ON "prepaid_conversion_intents"("shipment_id");
CREATE INDEX "prepaid_conversion_intents_growth_offer_id_idx" ON "prepaid_conversion_intents"("growth_offer_id");
CREATE INDEX "prepaid_conversion_intents_status_idx" ON "prepaid_conversion_intents"("status");
CREATE INDEX "prepaid_conversion_intents_expires_at_idx" ON "prepaid_conversion_intents"("expires_at");
CREATE INDEX "prepaid_conversion_intents_created_at_idx" ON "prepaid_conversion_intents"("created_at");
