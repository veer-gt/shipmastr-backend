-- H2B-2 dormant public provider ingress foundation.
-- This migration is additive and must be applied only through the approved
-- local scratch proof until a later deployment review.
CREATE TYPE "H2BEndpointStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "H2BEndpointTokenRole" AS ENUM ('CURRENT', 'PREVIOUS');
CREATE TYPE "H2BAdmissionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'PROCESSED', 'FAILED');
CREATE TYPE "H2BOutboxStatus" AS ENUM ('PENDING', 'CLAIMED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD_LETTER');
CREATE SEQUENCE "h2b_webhook_admissions_ingestion_sequence_seq";

CREATE TABLE "h2b_connection_endpoints" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "status" "H2BEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "h2b_connection_endpoints_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "h2b_connection_endpoints_connection_id_key" ON "h2b_connection_endpoints"("connection_id");
CREATE INDEX "h2b_connection_endpoints_merchant_id_status_idx" ON "h2b_connection_endpoints"("merchant_id", "status");
CREATE INDEX "h2b_connection_endpoints_merchant_id_connection_id_idx" ON "h2b_connection_endpoints"("merchant_id", "connection_id");
ALTER TABLE "h2b_connection_endpoints" ADD CONSTRAINT "h2b_connection_endpoints_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "h2b_connection_endpoints" ADD CONSTRAINT "h2b_connection_endpoints_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "platform_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "h2b_connection_endpoint_tokens" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "role" "H2BEndpointTokenRole" NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "generation" INTEGER NOT NULL,
    "activated_at" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "safe_fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "h2b_connection_endpoint_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "h2b_connection_endpoint_tokens_digest_key" ON "h2b_connection_endpoint_tokens"("digest");
CREATE UNIQUE INDEX "h2b_connection_endpoint_tokens_endpoint_id_role_key" ON "h2b_connection_endpoint_tokens"("endpoint_id", "role");
CREATE INDEX "h2b_connection_endpoint_tokens_endpoint_id_role_revoked_at_idx" ON "h2b_connection_endpoint_tokens"("endpoint_id", "role", "revoked_at");
ALTER TABLE "h2b_connection_endpoint_tokens" ADD CONSTRAINT "h2b_connection_endpoint_tokens_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "h2b_connection_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
    "ingestion_sequence" BIGINT NOT NULL DEFAULT nextval('h2b_webhook_admissions_ingestion_sequence_seq'),
    CONSTRAINT "h2b_webhook_admissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "h2b_webhook_admissions_platform_connection_id_delivery_id_key" ON "h2b_webhook_admissions"("platform", "connection_id", "delivery_id");
CREATE UNIQUE INDEX "h2b_webhook_admissions_ingestion_sequence_key" ON "h2b_webhook_admissions"("ingestion_sequence");
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
    "claim_version" BIGINT NOT NULL DEFAULT 0,
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
    "create_state" JSONB,
    "update_state" JSONB,
    "safe_state" JSONB NOT NULL,
    "latest_create_sequence" BIGINT NOT NULL DEFAULT 0,
    "latest_update_sequence" BIGINT NOT NULL DEFAULT 0,
    "latest_seen_sequence" BIGINT NOT NULL DEFAULT 0,
    "latest_event_at" TIMESTAMP(3),
    "latest_topic" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "h2b_external_order_aggregates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "h2b_external_order_aggregates_merchant_id_connection_id_external_order_id_key" ON "h2b_external_order_aggregates"("merchant_id", "connection_id", "external_order_id");
CREATE INDEX "h2b_external_order_aggregates_merchant_id_platform_idx" ON "h2b_external_order_aggregates"("merchant_id", "platform");
CREATE INDEX "h2b_external_order_aggregates_connection_id_external_order_id_idx" ON "h2b_external_order_aggregates"("connection_id", "external_order_id");
ALTER TABLE "h2b_external_order_aggregates" ADD CONSTRAINT "h2b_external_order_aggregates_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "h2b_external_order_aggregates" ADD CONSTRAINT "h2b_external_order_aggregates_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "platform_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "h2b_external_order_admission_references" (
    "id" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "admission_id" TEXT NOT NULL,
    "ingestion_sequence" BIGINT NOT NULL,
    "topic" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "h2b_external_order_admission_references_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "h2b_external_order_admission_references_admission_id_key" ON "h2b_external_order_admission_references"("admission_id");
CREATE UNIQUE INDEX "h2b_external_order_admission_references_aggregate_id_admission_id_key" ON "h2b_external_order_admission_references"("aggregate_id", "admission_id");
CREATE INDEX "h2b_external_order_admission_references_aggregate_id_idx" ON "h2b_external_order_admission_references"("aggregate_id");
CREATE INDEX "h2b_external_order_admission_references_aggregate_id_ingestion_sequence_idx" ON "h2b_external_order_admission_references"("aggregate_id", "ingestion_sequence");
ALTER TABLE "h2b_external_order_admission_references" ADD CONSTRAINT "h2b_external_order_admission_references_aggregate_id_fkey" FOREIGN KEY ("aggregate_id") REFERENCES "h2b_external_order_aggregates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "h2b_external_order_admission_references" ADD CONSTRAINT "h2b_external_order_admission_references_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "h2b_webhook_admissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
