-- H2B-2 dormant public provider ingress foundation.
-- This migration is additive and must be applied only through the approved
-- local scratch proof until a later deployment review.
CREATE TYPE "H2BEndpointStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "H2BAdmissionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'PROCESSED', 'FAILED');
CREATE TYPE "H2BOutboxStatus" AS ENUM ('PENDING', 'CLAIMED', 'PROCESSED', 'FAILED', 'DEAD_LETTER');

CREATE TABLE "h2b_connection_endpoints" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "status" "H2BEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "current_digest" TEXT NOT NULL,
    "current_activated_at" TIMESTAMP(3) NOT NULL,
    "previous_digest" TEXT,
    "previous_valid_until" TIMESTAMP(3),
    "safe_fingerprint" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "h2b_connection_endpoints_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "h2b_connection_endpoints_connection_id_key" ON "h2b_connection_endpoints"("connection_id");
CREATE UNIQUE INDEX "h2b_connection_endpoints_current_digest_key" ON "h2b_connection_endpoints"("current_digest");
CREATE INDEX "h2b_connection_endpoints_merchant_id_status_idx" ON "h2b_connection_endpoints"("merchant_id", "status");
CREATE INDEX "h2b_connection_endpoints_merchant_id_connection_id_idx" ON "h2b_connection_endpoints"("merchant_id", "connection_id");
CREATE INDEX "h2b_connection_endpoints_previous_digest_idx" ON "h2b_connection_endpoints"("previous_digest");
ALTER TABLE "h2b_connection_endpoints" ADD CONSTRAINT "h2b_connection_endpoints_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "h2b_connection_endpoints" ADD CONSTRAINT "h2b_connection_endpoints_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "platform_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "h2b_webhook_admissions" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "topic" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "safe_envelope" JSONB NOT NULL,
    "status" "H2BAdmissionStatus" NOT NULL DEFAULT 'PENDING',
    "failure_class" TEXT,
    "duplicate" BOOLEAN NOT NULL DEFAULT false,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "h2b_webhook_admissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "h2b_webhook_admissions_platform_connection_id_delivery_id_key" ON "h2b_webhook_admissions"("platform", "connection_id", "delivery_id");
CREATE INDEX "h2b_webhook_admissions_merchant_id_status_idx" ON "h2b_webhook_admissions"("merchant_id", "status");
CREATE INDEX "h2b_webhook_admissions_connection_id_received_at_idx" ON "h2b_webhook_admissions"("connection_id", "received_at");
ALTER TABLE "h2b_webhook_admissions" ADD CONSTRAINT "h2b_webhook_admissions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "h2b_webhook_admissions" ADD CONSTRAINT "h2b_webhook_admissions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "platform_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "h2b_webhook_outbox" (
    "id" TEXT NOT NULL,
    "admission_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "topic" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "status" "H2BOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMP(3),
    "lease_until" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure_class" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "h2b_webhook_outbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "h2b_webhook_outbox_admission_id_key" ON "h2b_webhook_outbox"("admission_id");
CREATE INDEX "h2b_webhook_outbox_merchant_id_status_next_attempt_at_idx" ON "h2b_webhook_outbox"("merchant_id", "status", "next_attempt_at");
CREATE INDEX "h2b_webhook_outbox_connection_id_created_at_idx" ON "h2b_webhook_outbox"("connection_id", "created_at");
ALTER TABLE "h2b_webhook_outbox" ADD CONSTRAINT "h2b_webhook_outbox_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "h2b_webhook_admissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "h2b_webhook_outbox" ADD CONSTRAINT "h2b_webhook_outbox_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "h2b_webhook_outbox" ADD CONSTRAINT "h2b_webhook_outbox_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "platform_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "h2b_external_order_aggregates" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "external_order_name" TEXT,
    "safe_state" JSONB NOT NULL,
    "latest_sequence" BIGINT NOT NULL DEFAULT 0,
    "latest_event_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "h2b_external_order_aggregates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "h2b_external_order_aggregates_merchant_id_connection_id_external_order_id_key" ON "h2b_external_order_aggregates"("merchant_id", "connection_id", "external_order_id");
CREATE INDEX "h2b_external_order_aggregates_merchant_id_platform_idx" ON "h2b_external_order_aggregates"("merchant_id", "platform");
CREATE INDEX "h2b_external_order_aggregates_connection_id_external_order_id_idx" ON "h2b_external_order_aggregates"("connection_id", "external_order_id");
ALTER TABLE "h2b_external_order_aggregates" ADD CONSTRAINT "h2b_external_order_aggregates_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "h2b_external_order_aggregates" ADD CONSTRAINT "h2b_external_order_aggregates_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "platform_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
