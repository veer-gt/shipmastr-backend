CREATE TABLE "early_cod_prequalification_batches" (
  "id" TEXT NOT NULL,
  "seller_org_id" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "source_ref" TEXT NOT NULL,
  "source_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "gross_cod_due_minor" BIGINT NOT NULL DEFAULT 0,
  "expected_deduction_minor" BIGINT NOT NULL DEFAULT 0,
  "risk_reserve_minor" BIGINT NOT NULL DEFAULT 0,
  "partner_fee_estimate_minor" BIGINT NOT NULL DEFAULT 0,
  "eligible_base_minor" BIGINT NOT NULL DEFAULT 0,
  "max_preview_advance_minor" BIGINT NOT NULL DEFAULT 0,
  "preview_advance_minor" BIGINT NOT NULL DEFAULT 0,
  "review_required_count" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "early_cod_prequalification_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "early_cod_prequalification_items" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "seller_org_id" TEXT NOT NULL,
  "cod_instruction_batch_id" TEXT,
  "checkout_preview_batch_id" TEXT,
  "courier_code" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "gross_cod_due_minor" BIGINT NOT NULL DEFAULT 0,
  "expected_deduction_minor" BIGINT NOT NULL DEFAULT 0,
  "risk_reserve_minor" BIGINT NOT NULL DEFAULT 0,
  "partner_fee_estimate_minor" BIGINT NOT NULL DEFAULT 0,
  "max_advance_rate_bps" BIGINT NOT NULL DEFAULT 0,
  "requested_advance_minor" BIGINT NOT NULL DEFAULT 0,
  "eligible_base_minor" BIGINT NOT NULL DEFAULT 0,
  "max_preview_advance_minor" BIGINT NOT NULL DEFAULT 0,
  "preview_advance_minor" BIGINT NOT NULL DEFAULT 0,
  "days_since_delivery" BIGINT NOT NULL DEFAULT 0,
  "dispute_count" BIGINT NOT NULL DEFAULT 0,
  "rto_count" BIGINT NOT NULL DEFAULT 0,
  "review_issue_count" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "review_reasons" JSONB,
  "source_row_hash" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "early_cod_prequalification_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "early_cod_prequalification_events" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "item_id" TEXT,
  "event_type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "message" TEXT,
  "metadata" JSONB,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "early_cod_prequalification_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "early_cod_prequalification_batches_seller_org_id_period_source_ref_key"
  ON "early_cod_prequalification_batches"("seller_org_id", "period", "source_ref");

CREATE INDEX "early_cod_prequalification_batches_seller_org_id_idx" ON "early_cod_prequalification_batches"("seller_org_id");
CREATE INDEX "early_cod_prequalification_batches_period_idx" ON "early_cod_prequalification_batches"("period");
CREATE INDEX "early_cod_prequalification_batches_status_idx" ON "early_cod_prequalification_batches"("status");
CREATE INDEX "early_cod_prequalification_batches_created_at_idx" ON "early_cod_prequalification_batches"("created_at");

CREATE INDEX "early_cod_prequalification_items_batch_id_idx" ON "early_cod_prequalification_items"("batch_id");
CREATE INDEX "early_cod_prequalification_items_seller_org_id_idx" ON "early_cod_prequalification_items"("seller_org_id");
CREATE INDEX "early_cod_prequalification_items_cod_instruction_batch_id_idx" ON "early_cod_prequalification_items"("cod_instruction_batch_id");
CREATE INDEX "early_cod_prequalification_items_checkout_preview_batch_id_idx" ON "early_cod_prequalification_items"("checkout_preview_batch_id");
CREATE INDEX "early_cod_prequalification_items_status_idx" ON "early_cod_prequalification_items"("status");

CREATE INDEX "early_cod_prequalification_events_batch_id_idx" ON "early_cod_prequalification_events"("batch_id");
CREATE INDEX "early_cod_prequalification_events_item_id_idx" ON "early_cod_prequalification_events"("item_id");
CREATE INDEX "early_cod_prequalification_events_event_type_idx" ON "early_cod_prequalification_events"("event_type");
CREATE INDEX "early_cod_prequalification_events_status_idx" ON "early_cod_prequalification_events"("status");
CREATE INDEX "early_cod_prequalification_events_created_at_idx" ON "early_cod_prequalification_events"("created_at");

ALTER TABLE "early_cod_prequalification_items"
  ADD CONSTRAINT "early_cod_prequalification_items_batch_id_fkey"
  FOREIGN KEY ("batch_id") REFERENCES "early_cod_prequalification_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "early_cod_prequalification_events"
  ADD CONSTRAINT "early_cod_prequalification_events_batch_id_fkey"
  FOREIGN KEY ("batch_id") REFERENCES "early_cod_prequalification_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "early_cod_prequalification_events"
  ADD CONSTRAINT "early_cod_prequalification_events_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "early_cod_prequalification_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
