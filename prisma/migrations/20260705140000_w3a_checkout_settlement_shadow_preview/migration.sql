CREATE TABLE "checkout_settlement_preview_batches" (
    "id" TEXT NOT NULL,
    "seller_org_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "source_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "gross_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "payment_fee_minor" BIGINT NOT NULL DEFAULT 0,
    "platform_fee_minor" BIGINT NOT NULL DEFAULT 0,
    "shipping_charge_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "refund_minor" BIGINT NOT NULL DEFAULT 0,
    "adjustment_minor" BIGINT NOT NULL DEFAULT 0,
    "seller_preview_receivable_minor" BIGINT NOT NULL DEFAULT 0,
    "negative_preview_minor" BIGINT NOT NULL DEFAULT 0,
    "review_required_count" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_settlement_preview_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_settlement_preview_items" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "seller_org_id" TEXT NOT NULL,
    "checkout_ref" TEXT,
    "order_ref" TEXT,
    "shipment_id" TEXT,
    "period" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "gross_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "payment_fee_minor" BIGINT NOT NULL DEFAULT 0,
    "platform_fee_minor" BIGINT NOT NULL DEFAULT 0,
    "shipping_charge_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "refund_minor" BIGINT NOT NULL DEFAULT 0,
    "adjustment_minor" BIGINT NOT NULL DEFAULT 0,
    "seller_preview_receivable_minor" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "review_reasons" JSONB,
    "source_row_hash" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_settlement_preview_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_settlement_preview_allocations" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "item_id" TEXT,
    "bucket" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_settlement_preview_allocations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_settlement_preview_events" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "item_id" TEXT,
    "event_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "metadata" JSONB,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_settlement_preview_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "checkout_settlement_preview_batches_seller_org_id_period_source_ref_key"
ON "checkout_settlement_preview_batches"("seller_org_id", "period", "source_ref");

CREATE INDEX "checkout_settlement_preview_batches_seller_org_id_idx"
ON "checkout_settlement_preview_batches"("seller_org_id");

CREATE INDEX "checkout_settlement_preview_batches_period_idx"
ON "checkout_settlement_preview_batches"("period");

CREATE INDEX "checkout_settlement_preview_batches_status_idx"
ON "checkout_settlement_preview_batches"("status");

CREATE INDEX "checkout_settlement_preview_batches_created_at_idx"
ON "checkout_settlement_preview_batches"("created_at");

CREATE INDEX "checkout_settlement_preview_items_batch_id_idx"
ON "checkout_settlement_preview_items"("batch_id");

CREATE INDEX "checkout_settlement_preview_items_seller_org_id_idx"
ON "checkout_settlement_preview_items"("seller_org_id");

CREATE INDEX "checkout_settlement_preview_items_checkout_ref_idx"
ON "checkout_settlement_preview_items"("checkout_ref");

CREATE INDEX "checkout_settlement_preview_items_status_idx"
ON "checkout_settlement_preview_items"("status");

CREATE INDEX "checkout_settlement_preview_allocations_batch_id_idx"
ON "checkout_settlement_preview_allocations"("batch_id");

CREATE INDEX "checkout_settlement_preview_allocations_item_id_idx"
ON "checkout_settlement_preview_allocations"("item_id");

CREATE INDEX "checkout_settlement_preview_allocations_bucket_idx"
ON "checkout_settlement_preview_allocations"("bucket");

CREATE INDEX "checkout_settlement_preview_events_batch_id_idx"
ON "checkout_settlement_preview_events"("batch_id");

CREATE INDEX "checkout_settlement_preview_events_item_id_idx"
ON "checkout_settlement_preview_events"("item_id");

CREATE INDEX "checkout_settlement_preview_events_event_type_idx"
ON "checkout_settlement_preview_events"("event_type");

CREATE INDEX "checkout_settlement_preview_events_status_idx"
ON "checkout_settlement_preview_events"("status");

CREATE INDEX "checkout_settlement_preview_events_created_at_idx"
ON "checkout_settlement_preview_events"("created_at");

ALTER TABLE "checkout_settlement_preview_items"
ADD CONSTRAINT "checkout_settlement_preview_items_batch_id_fkey"
FOREIGN KEY ("batch_id") REFERENCES "checkout_settlement_preview_batches"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "checkout_settlement_preview_allocations"
ADD CONSTRAINT "checkout_settlement_preview_allocations_batch_id_fkey"
FOREIGN KEY ("batch_id") REFERENCES "checkout_settlement_preview_batches"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "checkout_settlement_preview_allocations"
ADD CONSTRAINT "checkout_settlement_preview_allocations_item_id_fkey"
FOREIGN KEY ("item_id") REFERENCES "checkout_settlement_preview_items"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "checkout_settlement_preview_events"
ADD CONSTRAINT "checkout_settlement_preview_events_batch_id_fkey"
FOREIGN KEY ("batch_id") REFERENCES "checkout_settlement_preview_batches"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "checkout_settlement_preview_events"
ADD CONSTRAINT "checkout_settlement_preview_events_item_id_fkey"
FOREIGN KEY ("item_id") REFERENCES "checkout_settlement_preview_items"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
