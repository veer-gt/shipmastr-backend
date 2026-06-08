-- Phase 29: Merchant onboarding + store connection activation flow.
-- Additive state table only. No platform writes, courier calls, AWB, labels, or automatic shipping actions.

CREATE TABLE "merchant_onboarding_states" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "current_step" TEXT NOT NULL DEFAULT 'WELCOME',
  "store_connected" BOOLEAN NOT NULL DEFAULT false,
  "credentials_ready" BOOLEAN NOT NULL DEFAULT false,
  "first_fetch_completed" BOOLEAN NOT NULL DEFAULT false,
  "reconciliation_viewed" BOOLEAN NOT NULL DEFAULT false,
  "first_conversion_completed" BOOLEAN NOT NULL DEFAULT false,
  "shipping_workspace_ready" BOOLEAN NOT NULL DEFAULT false,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_onboarding_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_onboarding_states_merchant_id_key"
  ON "merchant_onboarding_states"("merchant_id");

CREATE INDEX "merchant_onboarding_states_merchant_id_current_step_idx"
  ON "merchant_onboarding_states"("merchant_id", "current_step");
