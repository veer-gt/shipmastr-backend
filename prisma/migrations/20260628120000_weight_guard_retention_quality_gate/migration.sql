ALTER TABLE "shipping_weight_proof_capture_sessions"
  ADD COLUMN "image_checksum" TEXT,
  ADD COLUMN "image_size_bytes" INTEGER,
  ADD COLUMN "quality_status" TEXT,
  ADD COLUMN "quality_reason_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "shipping_weight_proofs"
  ADD COLUMN "image_checksum" TEXT,
  ADD COLUMN "image_size_bytes" INTEGER,
  ADD COLUMN "image_quality_status" TEXT,
  ADD COLUMN "image_quality_reason_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "image_retention_status" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "image_deleted_at" TIMESTAMP(3),
  ADD COLUMN "image_deletion_reason" TEXT,
  ADD COLUMN "deleted_after_settlement_ref" TEXT;

CREATE INDEX "shipping_weight_proofs_image_retention_status_idx"
  ON "shipping_weight_proofs"("image_retention_status");
