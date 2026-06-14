-- Phase 41: Multi-provider live courier readiness foundation.
-- These records store credential references and safe readiness summaries only.
-- They must never contain plaintext provider credentials, raw headers, or raw provider payloads.

CREATE TABLE "courier_provider_credentials" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT,
  "provider_key" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "credential_ref" TEXT,
  "required_fields" JSONB,
  "safe_meta" JSONB,
  "last_tested_at" TIMESTAMP(3),
  "last_test_status" TEXT,
  "last_test_summary" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "courier_provider_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "courier_provider_readiness_probes" (
  "id" TEXT NOT NULL,
  "credential_id" TEXT,
  "merchant_id" TEXT,
  "provider_key" TEXT NOT NULL,
  "probe_type" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "safe_summary" JSONB,
  "warnings" JSONB,
  "errors" JSONB,
  "tested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "courier_provider_readiness_probes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "courier_provider_credentials_merchant_id_provider_key_mode_idx"
  ON "courier_provider_credentials"("merchant_id", "provider_key", "mode");
CREATE INDEX "courier_provider_credentials_provider_key_status_idx"
  ON "courier_provider_credentials"("provider_key", "status");
CREATE INDEX "courier_provider_credentials_last_tested_at_idx"
  ON "courier_provider_credentials"("last_tested_at");

CREATE INDEX "courier_provider_readiness_probes_merchant_id_provider_key_idx"
  ON "courier_provider_readiness_probes"("merchant_id", "provider_key");
CREATE INDEX "courier_provider_readiness_probes_provider_key_status_idx"
  ON "courier_provider_readiness_probes"("provider_key", "status");
CREATE INDEX "courier_provider_readiness_probes_tested_at_idx"
  ON "courier_provider_readiness_probes"("tested_at");
