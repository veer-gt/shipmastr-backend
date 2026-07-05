CREATE TABLE "cod_netting_batches" (
  "id" TEXT NOT NULL,
  "seller_org_id" TEXT NOT NULL,
  "courier_code" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "source_ref" TEXT NOT NULL,
  "source_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "cod_collected_minor" BIGINT NOT NULL DEFAULT 0,
  "freight_deduction_minor" BIGINT NOT NULL DEFAULT 0,
  "rto_deduction_minor" BIGINT NOT NULL DEFAULT 0,
  "adjustment_minor" BIGINT NOT NULL DEFAULT 0,
  "seller_net_receivable_minor" BIGINT NOT NULL DEFAULT 0,
  "negative_net_minor" BIGINT NOT NULL DEFAULT 0,
  "review_required_count" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cod_netting_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cod_netting_items" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "seller_org_id" TEXT NOT NULL,
  "courier_code" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "shipment_id" TEXT,
  "delivered_at" TIMESTAMP(3),
  "cod_collected_minor" BIGINT NOT NULL DEFAULT 0,
  "freight_deduction_minor" BIGINT NOT NULL DEFAULT 0,
  "rto_deduction_minor" BIGINT NOT NULL DEFAULT 0,
  "adjustment_minor" BIGINT NOT NULL DEFAULT 0,
  "expected_remittance_minor" BIGINT,
  "remittance_ref" TEXT,
  "seller_net_receivable_minor" BIGINT NOT NULL DEFAULT 0,
  "instruction_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "review_reasons" JSONB,
  "source_row_hash" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cod_netting_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cod_netting_instruction_events" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "item_id" TEXT,
  "event_type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "message" TEXT,
  "metadata" JSONB,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cod_netting_instruction_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cod_netting_batches_seller_org_id_courier_code_period_source_ref_key" ON "cod_netting_batches"("seller_org_id", "courier_code", "period", "source_ref");
CREATE INDEX "cod_netting_batches_seller_org_id_idx" ON "cod_netting_batches"("seller_org_id");
CREATE INDEX "cod_netting_batches_courier_code_idx" ON "cod_netting_batches"("courier_code");
CREATE INDEX "cod_netting_batches_period_idx" ON "cod_netting_batches"("period");
CREATE INDEX "cod_netting_batches_status_idx" ON "cod_netting_batches"("status");
CREATE INDEX "cod_netting_batches_created_at_idx" ON "cod_netting_batches"("created_at");

CREATE INDEX "cod_netting_items_batch_id_idx" ON "cod_netting_items"("batch_id");
CREATE INDEX "cod_netting_items_seller_org_id_idx" ON "cod_netting_items"("seller_org_id");
CREATE INDEX "cod_netting_items_courier_code_idx" ON "cod_netting_items"("courier_code");
CREATE INDEX "cod_netting_items_shipment_id_idx" ON "cod_netting_items"("shipment_id");
CREATE INDEX "cod_netting_items_status_idx" ON "cod_netting_items"("status");

CREATE INDEX "cod_netting_instruction_events_batch_id_idx" ON "cod_netting_instruction_events"("batch_id");
CREATE INDEX "cod_netting_instruction_events_item_id_idx" ON "cod_netting_instruction_events"("item_id");
CREATE INDEX "cod_netting_instruction_events_event_type_idx" ON "cod_netting_instruction_events"("event_type");
CREATE INDEX "cod_netting_instruction_events_status_idx" ON "cod_netting_instruction_events"("status");
CREATE INDEX "cod_netting_instruction_events_created_at_idx" ON "cod_netting_instruction_events"("created_at");

ALTER TABLE "cod_netting_items" ADD CONSTRAINT "cod_netting_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "cod_netting_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cod_netting_instruction_events" ADD CONSTRAINT "cod_netting_instruction_events_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "cod_netting_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cod_netting_instruction_events" ADD CONSTRAINT "cod_netting_instruction_events_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "cod_netting_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
