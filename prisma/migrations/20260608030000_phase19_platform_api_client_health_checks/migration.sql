CREATE TYPE "PlatformHealthCheckStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'FAILED', 'NOT_CONFIGURED', 'SKIPPED');

CREATE TYPE "PlatformHealthCheckType" AS ENUM ('AUTHENTICATION', 'READ_PERMISSIONS', 'WEBHOOK_CAPABILITY', 'TRACKING_SYNC_CAPABILITY', 'FULFILLMENT_CAPABILITY', 'OVERALL');

CREATE TABLE "platform_connection_health_checks" (
  "id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "platform" "StorePlatform" NOT NULL,
  "check_type" "PlatformHealthCheckType" NOT NULL,
  "status" "PlatformHealthCheckStatus" NOT NULL,
  "message" TEXT NOT NULL,
  "safe_details" JSONB,
  "error_code" TEXT,
  "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_connection_health_checks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_connection_health_checks_merchant_id_platform_idx" ON "platform_connection_health_checks"("merchant_id", "platform");
CREATE INDEX "platform_connection_health_checks_connection_id_checked_at_idx" ON "platform_connection_health_checks"("connection_id", "checked_at");
CREATE INDEX "platform_connection_health_checks_merchant_id_status_idx" ON "platform_connection_health_checks"("merchant_id", "status");
