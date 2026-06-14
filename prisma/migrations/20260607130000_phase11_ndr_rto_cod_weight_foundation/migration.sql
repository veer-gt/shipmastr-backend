-- Phase 11: NDR/RTO Operations + COD Ledger + Weight Dispute Foundation
-- Additive operational tables only. No existing shipment/order/provider data is mutated.

CREATE TABLE "ndr_cases" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "shipment_id" TEXT NOT NULL,
  "order_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "reason_code" TEXT,
  "reason_label" TEXT,
  "buyer_issue_type" TEXT,
  "latest_attempt_at" TIMESTAMP(3),
  "next_action_by" TIMESTAMP(3),
  "seller_action" TEXT,
  "action_payload_json" JSONB,
  "provider_action_ref" TEXT,
  "provider_status" TEXT,
  "internal_notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ndr_cases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ndr_action_attempts" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "ndr_case_id" TEXT NOT NULL,
  "shipment_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'recorded',
  "payload_json" JSONB,
  "provider_ref" TEXT,
  "error_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ndr_action_attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rto_cases" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "shipment_id" TEXT NOT NULL,
  "order_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'initiated',
  "rto_reason_code" TEXT,
  "rto_reason_label" TEXT,
  "initiated_at" TIMESTAMP(3),
  "received_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "forward_freight_paise" INTEGER,
  "rto_freight_paise" INTEGER,
  "cod_lost_paise" INTEGER,
  "estimated_loss_paise" INTEGER,
  "provider_status" TEXT,
  "metadata_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rto_cases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cod_ledger_entries" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "shipment_id" TEXT,
  "order_id" TEXT,
  "entry_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "amount_paise" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "expected_collection_at" TIMESTAMP(3),
  "collected_at" TIMESTAMP(3),
  "remittance_due_at" TIMESTAMP(3),
  "remitted_at" TIMESTAMP(3),
  "reference" TEXT,
  "notes" TEXT,
  "metadata_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cod_ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "weight_discrepancy_cases" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "shipment_id" TEXT NOT NULL,
  "order_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'detected',
  "declared_weight_grams" INTEGER,
  "volumetric_weight_grams" INTEGER,
  "billed_weight_grams" INTEGER,
  "difference_grams" INTEGER,
  "expected_charge_paise" INTEGER,
  "billed_charge_paise" INTEGER,
  "difference_paise" INTEGER,
  "reason_code" TEXT,
  "reason_label" TEXT,
  "evidence_json" JSONB,
  "provider_ref" TEXT,
  "provider_status" TEXT,
  "internal_notes" TEXT,
  "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submitted_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "weight_discrepancy_cases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ndr_cases_merchant_id_status_idx" ON "ndr_cases"("merchant_id", "status");
CREATE INDEX "ndr_cases_shipment_id_idx" ON "ndr_cases"("shipment_id");
CREATE INDEX "ndr_cases_merchant_id_created_at_idx" ON "ndr_cases"("merchant_id", "created_at");
CREATE INDEX "ndr_action_attempts_merchant_id_ndr_case_id_idx" ON "ndr_action_attempts"("merchant_id", "ndr_case_id");
CREATE INDEX "ndr_action_attempts_shipment_id_idx" ON "ndr_action_attempts"("shipment_id");
CREATE INDEX "rto_cases_merchant_id_status_idx" ON "rto_cases"("merchant_id", "status");
CREATE INDEX "rto_cases_shipment_id_idx" ON "rto_cases"("shipment_id");
CREATE INDEX "rto_cases_merchant_id_created_at_idx" ON "rto_cases"("merchant_id", "created_at");
CREATE INDEX "cod_ledger_entries_merchant_id_status_idx" ON "cod_ledger_entries"("merchant_id", "status");
CREATE INDEX "cod_ledger_entries_shipment_id_idx" ON "cod_ledger_entries"("shipment_id");
CREATE INDEX "cod_ledger_entries_order_id_idx" ON "cod_ledger_entries"("order_id");
CREATE INDEX "cod_ledger_entries_merchant_id_created_at_idx" ON "cod_ledger_entries"("merchant_id", "created_at");
CREATE INDEX "weight_discrepancy_cases_merchant_id_status_idx" ON "weight_discrepancy_cases"("merchant_id", "status");
CREATE INDEX "weight_discrepancy_cases_shipment_id_idx" ON "weight_discrepancy_cases"("shipment_id");
CREATE INDEX "weight_discrepancy_cases_merchant_id_created_at_idx" ON "weight_discrepancy_cases"("merchant_id", "created_at");
