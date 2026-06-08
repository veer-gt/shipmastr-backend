-- Phase 26: Controlled production queue worker foundation.
-- Additive run observability table only. Workers remain disabled and dry-run by default.
-- No continuous scheduler, platform writes, courier calls, rates, AWB, labels, or email sending.

CREATE TABLE "shipmastr_worker_runs" (
  "id" TEXT NOT NULL,
  "worker_name" TEXT NOT NULL,
  "merchant_id" TEXT,
  "status" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "processed_count" INTEGER NOT NULL DEFAULT 0,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "warnings" JSONB,
  "errors" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shipmastr_worker_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shipmastr_worker_runs_worker_name_status_idx"
  ON "shipmastr_worker_runs"("worker_name", "status");

CREATE INDEX "shipmastr_worker_runs_started_at_idx"
  ON "shipmastr_worker_runs"("started_at");

CREATE INDEX "shipmastr_worker_runs_merchant_id_started_at_idx"
  ON "shipmastr_worker_runs"("merchant_id", "started_at");
