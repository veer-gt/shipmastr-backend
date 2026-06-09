-- Phase 32: Controlled live pilot preparation.
-- These records gate pilot approvals and capabilities only; they do not enable
-- external live behavior by themselves.

CREATE TABLE "live_pilot_merchants" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DISABLED',
  "notes" TEXT,
  "enabled_by" TEXT,
  "enabled_at" TIMESTAMP(3),
  "disabled_by" TEXT,
  "disabled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "live_pilot_merchants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "live_pilot_capabilities" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "capability" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DISABLED',
  "approval_id" TEXT,
  "notes" TEXT,
  "enabled_at" TIMESTAMP(3),
  "disabled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "live_pilot_capabilities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "live_pilot_approvals" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT,
  "approval_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "approved_by" TEXT,
  "approved_at" TIMESTAMP(3),
  "revoked_by" TEXT,
  "revoked_at" TIMESTAMP(3),
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "live_pilot_approvals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "live_pilot_audit_logs" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT,
  "action" TEXT NOT NULL,
  "actor_id" TEXT,
  "target_type" TEXT,
  "target_id" TEXT,
  "safe_meta" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "live_pilot_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "live_pilot_merchants_merchant_id_key" ON "live_pilot_merchants"("merchant_id");
CREATE INDEX "live_pilot_merchants_status_idx" ON "live_pilot_merchants"("status");
CREATE INDEX "live_pilot_merchants_merchant_id_status_idx" ON "live_pilot_merchants"("merchant_id", "status");

CREATE UNIQUE INDEX "live_pilot_capabilities_merchant_id_capability_key" ON "live_pilot_capabilities"("merchant_id", "capability");
CREATE INDEX "live_pilot_capabilities_merchant_id_status_idx" ON "live_pilot_capabilities"("merchant_id", "status");
CREATE INDEX "live_pilot_capabilities_capability_status_idx" ON "live_pilot_capabilities"("capability", "status");

CREATE INDEX "live_pilot_approvals_merchant_id_approval_type_idx" ON "live_pilot_approvals"("merchant_id", "approval_type");
CREATE INDEX "live_pilot_approvals_status_idx" ON "live_pilot_approvals"("status");

CREATE INDEX "live_pilot_audit_logs_merchant_id_created_at_idx" ON "live_pilot_audit_logs"("merchant_id", "created_at");
CREATE INDEX "live_pilot_audit_logs_action_idx" ON "live_pilot_audit_logs"("action");
