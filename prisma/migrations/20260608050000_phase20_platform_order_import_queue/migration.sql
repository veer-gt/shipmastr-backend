CREATE TYPE "PlatformImportJobStatus" AS ENUM ('DRAFT', 'QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED');

CREATE TYPE "PlatformImportJobMode" AS ENUM ('DRY_RUN', 'IMPORT_FOUNDATION', 'READ_ONLY_FETCH_PLACEHOLDER');

CREATE TYPE "PlatformImportItemStatus" AS ENUM ('PENDING', 'MAPPED', 'IMPORTED', 'SKIPPED', 'FAILED', 'DUPLICATE');

CREATE TYPE "PlatformImportSource" AS ENUM ('MANUAL_PAYLOAD', 'WEBHOOK_PAYLOAD', 'POLLING_PLACEHOLDER', 'FILE_UPLOAD_PLACEHOLDER');

CREATE TABLE "platform_import_jobs" (
  "id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "platform" "StorePlatform" NOT NULL,
  "mode" "PlatformImportJobMode" NOT NULL,
  "source" "PlatformImportSource" NOT NULL,
  "status" "PlatformImportJobStatus" NOT NULL DEFAULT 'QUEUED',
  "requested_by" TEXT,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "total_items" INTEGER NOT NULL DEFAULT 0,
  "mapped_items" INTEGER NOT NULL DEFAULT 0,
  "imported_items" INTEGER NOT NULL DEFAULT 0,
  "skipped_items" INTEGER NOT NULL DEFAULT 0,
  "duplicate_items" INTEGER NOT NULL DEFAULT 0,
  "failed_items" INTEGER NOT NULL DEFAULT 0,
  "warning_count" INTEGER NOT NULL DEFAULT 0,
  "safe_summary" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_import_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_import_items" (
  "id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "platform" "StorePlatform" NOT NULL,
  "external_order_id" TEXT,
  "external_order_name" TEXT,
  "payload_hash" TEXT NOT NULL,
  "status" "PlatformImportItemStatus" NOT NULL DEFAULT 'PENDING',
  "order_import_id" TEXT,
  "normalized_order_id" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMP(3),
  "next_attempt_at" TIMESTAMP(3),
  "error_code" TEXT,
  "error_message" TEXT,
  "mapping_warnings" JSONB,
  "safe_payload_preview" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_import_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_import_jobs_merchant_id_status_idx" ON "platform_import_jobs"("merchant_id", "status");
CREATE INDEX "platform_import_jobs_connection_id_created_at_idx" ON "platform_import_jobs"("connection_id", "created_at");
CREATE INDEX "platform_import_jobs_merchant_id_platform_idx" ON "platform_import_jobs"("merchant_id", "platform");
CREATE INDEX "platform_import_jobs_merchant_id_created_at_idx" ON "platform_import_jobs"("merchant_id", "created_at");

CREATE INDEX "platform_import_items_job_id_idx" ON "platform_import_items"("job_id");
CREATE INDEX "platform_import_items_merchant_id_status_idx" ON "platform_import_items"("merchant_id", "status");
CREATE INDEX "platform_import_items_connection_id_external_order_id_idx" ON "platform_import_items"("connection_id", "external_order_id");
CREATE INDEX "platform_import_items_connection_id_payload_hash_idx" ON "platform_import_items"("connection_id", "payload_hash");
CREATE INDEX "platform_import_items_merchant_id_created_at_idx" ON "platform_import_items"("merchant_id", "created_at");
