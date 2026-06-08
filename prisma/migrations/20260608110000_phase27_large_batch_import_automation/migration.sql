CREATE TABLE "platform_import_cursors" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "platform" "StorePlatform" NOT NULL,
  "cursor" TEXT,
  "page" INTEGER,
  "since" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "last_job_id" TEXT,
  "has_more" BOOLEAN NOT NULL DEFAULT false,
  "warning_count" INTEGER NOT NULL DEFAULT 0,
  "error_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_import_cursors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_import_cursors_merchant_id_connection_id_platform_idx" ON "platform_import_cursors"("merchant_id", "connection_id", "platform");
CREATE INDEX "platform_import_cursors_merchant_id_status_idx" ON "platform_import_cursors"("merchant_id", "status");
CREATE INDEX "platform_import_cursors_connection_id_updated_at_idx" ON "platform_import_cursors"("connection_id", "updated_at");
