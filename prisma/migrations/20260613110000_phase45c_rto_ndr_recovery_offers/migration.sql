-- Phase 45C RTO/NDR recovery offer foundation.
-- Additive only. No communication sending, courier retry calls, courier/provider mutation, payment calls, or shipment recovered/delivered mutation.

ALTER TYPE "GrowthOfferType" ADD VALUE IF NOT EXISTS 'RTO_NDR_RECOVERY';

CREATE TYPE "RtoNdrRecoveryPolicyStatus" AS ENUM (
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'ARCHIVED'
);

CREATE TYPE "RtoNdrRecoveryActionType" AS ENUM (
  'CONFIRM_ADDRESS',
  'UPDATE_ADDRESS',
  'SELECT_RETRY_WINDOW',
  'SWITCH_TO_PREPAID',
  'ACCEPT_DELIVERY_INCENTIVE',
  'CONTACT_SUPPORT'
);

CREATE TYPE "RtoNdrRecoveryIntentStatus" AS ENUM (
  'OFFERED',
  'CLICKED',
  'INTENT_CREATED',
  'ACTION_PENDING',
  'RECOVERY_SIMULATED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TABLE "rto_ndr_recovery_policies" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" "RtoNdrRecoveryPolicyStatus" NOT NULL DEFAULT 'DRAFT',
  "action_type" "RtoNdrRecoveryActionType" NOT NULL,
  "incentive_amount_paise" INTEGER,
  "max_incentive_amount_paise" INTEGER,
  "min_order_amount_paise" INTEGER,
  "max_order_amount_paise" INTEGER,
  "allowed_failure_reasons" JSONB,
  "starts_at" TIMESTAMP(3),
  "ends_at" TIMESTAMP(3),
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "rto_ndr_recovery_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rto_ndr_recovery_intents" (
  "id" TEXT NOT NULL,
  "policy_id" TEXT,
  "merchant_id" TEXT,
  "seller_id" TEXT,
  "order_id" TEXT,
  "shipment_id" TEXT,
  "growth_offer_id" TEXT,
  "status" "RtoNdrRecoveryIntentStatus" NOT NULL DEFAULT 'INTENT_CREATED',
  "action_type" "RtoNdrRecoveryActionType" NOT NULL,
  "recovery_snapshot" JSONB NOT NULL,
  "idempotency_key" TEXT,
  "expires_at" TIMESTAMP(3),
  "recovered_at" TIMESTAMP(3),
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "rto_ndr_recovery_intents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rto_ndr_recovery_policies_merchant_id_idx" ON "rto_ndr_recovery_policies"("merchant_id");
CREATE INDEX "rto_ndr_recovery_policies_status_idx" ON "rto_ndr_recovery_policies"("status");
CREATE INDEX "rto_ndr_recovery_policies_action_type_idx" ON "rto_ndr_recovery_policies"("action_type");
CREATE INDEX "rto_ndr_recovery_policies_starts_at_idx" ON "rto_ndr_recovery_policies"("starts_at");
CREATE INDEX "rto_ndr_recovery_policies_ends_at_idx" ON "rto_ndr_recovery_policies"("ends_at");
CREATE INDEX "rto_ndr_recovery_policies_created_at_idx" ON "rto_ndr_recovery_policies"("created_at");

CREATE UNIQUE INDEX "rto_ndr_recovery_intents_idempotency_key_key" ON "rto_ndr_recovery_intents"("idempotency_key");
CREATE INDEX "rto_ndr_recovery_intents_policy_id_idx" ON "rto_ndr_recovery_intents"("policy_id");
CREATE INDEX "rto_ndr_recovery_intents_merchant_id_idx" ON "rto_ndr_recovery_intents"("merchant_id");
CREATE INDEX "rto_ndr_recovery_intents_seller_id_idx" ON "rto_ndr_recovery_intents"("seller_id");
CREATE INDEX "rto_ndr_recovery_intents_order_id_idx" ON "rto_ndr_recovery_intents"("order_id");
CREATE INDEX "rto_ndr_recovery_intents_shipment_id_idx" ON "rto_ndr_recovery_intents"("shipment_id");
CREATE INDEX "rto_ndr_recovery_intents_growth_offer_id_idx" ON "rto_ndr_recovery_intents"("growth_offer_id");
CREATE INDEX "rto_ndr_recovery_intents_status_idx" ON "rto_ndr_recovery_intents"("status");
CREATE INDEX "rto_ndr_recovery_intents_action_type_idx" ON "rto_ndr_recovery_intents"("action_type");
CREATE INDEX "rto_ndr_recovery_intents_expires_at_idx" ON "rto_ndr_recovery_intents"("expires_at");
CREATE INDEX "rto_ndr_recovery_intents_created_at_idx" ON "rto_ndr_recovery_intents"("created_at");
