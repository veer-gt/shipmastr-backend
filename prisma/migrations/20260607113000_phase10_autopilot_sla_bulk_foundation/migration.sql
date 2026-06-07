-- Phase 10: Autopilot + SLA Learning + Bulk Shipping Foundation
-- Additive-only operational tables. No existing shipping/order/provider data is changed.

CREATE TABLE "autopilot_preferences" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "is_enabled" BOOLEAN NOT NULL DEFAULT false,
  "default_mode" TEXT NOT NULL DEFAULT 'recommend_only',
  "preferred_tier" TEXT NOT NULL DEFAULT 'smart',
  "max_cod_amount" INTEGER,
  "max_order_amount" INTEGER,
  "max_weight_grams" INTEGER,
  "allow_cod_high_risk" BOOLEAN NOT NULL DEFAULT false,
  "allow_weight_high_risk" BOOLEAN NOT NULL DEFAULT false,
  "require_manual_review_high" BOOLEAN NOT NULL DEFAULT true,
  "rules_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "autopilot_preferences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "autopilot_decisions" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "shipment_id" TEXT NOT NULL,
  "order_id" TEXT,
  "mode" TEXT NOT NULL,
  "recommended_tier" TEXT NOT NULL,
  "selected_tier" TEXT,
  "decision_level" TEXT NOT NULL,
  "reasons_json" JSONB,
  "protection_json" JSONB,
  "rate_snapshot_json" JSONB,
  "applied" BOOLEAN NOT NULL DEFAULT false,
  "blocked_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "autopilot_decisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "courier_sla_events" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "shipment_id" TEXT NOT NULL,
  "order_id" TEXT,
  "provider" TEXT,
  "courier_code" TEXT,
  "courier_name" TEXT,
  "service_type" TEXT,
  "selected_tier" TEXT,
  "pickup_pincode" TEXT,
  "delivery_pincode" TEXT,
  "event_type" TEXT NOT NULL,
  "event_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "courier_sla_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "courier_sla_stats" (
  "id" TEXT NOT NULL,
  "provider" TEXT,
  "courier_code" TEXT,
  "courier_name" TEXT,
  "service_type" TEXT,
  "selected_tier" TEXT,
  "pickup_pincode" TEXT,
  "delivery_pincode" TEXT,
  "total_shipments" INTEGER NOT NULL DEFAULT 0,
  "delivered_count" INTEGER NOT NULL DEFAULT 0,
  "rto_count" INTEGER NOT NULL DEFAULT 0,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "avg_delivery_days" DOUBLE PRECISION,
  "reliability_score" DOUBLE PRECISION,
  "last_calculated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "courier_sla_stats_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bulk_shipping_batches" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "total_items" INTEGER NOT NULL DEFAULT 0,
  "success_count" INTEGER NOT NULL DEFAULT 0,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "skipped_count" INTEGER NOT NULL DEFAULT 0,
  "requested_tier" TEXT,
  "errors_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bulk_shipping_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bulk_shipping_items" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "shipment_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "result_json" JSONB,
  "error_code" TEXT,
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bulk_shipping_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "autopilot_preferences_merchant_id_key" ON "autopilot_preferences"("merchant_id");
CREATE INDEX "autopilot_preferences_merchant_id_idx" ON "autopilot_preferences"("merchant_id");
CREATE INDEX "autopilot_decisions_merchant_id_shipment_id_idx" ON "autopilot_decisions"("merchant_id", "shipment_id");
CREATE INDEX "autopilot_decisions_merchant_id_created_at_idx" ON "autopilot_decisions"("merchant_id", "created_at");
CREATE INDEX "courier_sla_events_merchant_id_event_type_idx" ON "courier_sla_events"("merchant_id", "event_type");
CREATE INDEX "courier_sla_events_provider_courier_code_delivery_pincode_idx" ON "courier_sla_events"("provider", "courier_code", "delivery_pincode");
CREATE INDEX "courier_sla_events_shipment_id_idx" ON "courier_sla_events"("shipment_id");
CREATE INDEX "courier_sla_stats_provider_courier_code_delivery_pincode_idx" ON "courier_sla_stats"("provider", "courier_code", "delivery_pincode");
CREATE INDEX "courier_sla_stats_selected_tier_idx" ON "courier_sla_stats"("selected_tier");
CREATE INDEX "bulk_shipping_batches_merchant_id_status_idx" ON "bulk_shipping_batches"("merchant_id", "status");
CREATE INDEX "bulk_shipping_batches_merchant_id_created_at_idx" ON "bulk_shipping_batches"("merchant_id", "created_at");
CREATE INDEX "bulk_shipping_items_batch_id_idx" ON "bulk_shipping_items"("batch_id");
CREATE INDEX "bulk_shipping_items_merchant_id_shipment_id_idx" ON "bulk_shipping_items"("merchant_id", "shipment_id");
