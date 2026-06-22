-- CreateEnum
CREATE TYPE "WeightProofCaptureStatus" AS ENUM ('CREATED', 'FINALIZED', 'EXPIRED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "shipping_weight_proof_capture_sessions" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "shipment_id" TEXT,
    "awb_number" TEXT NOT NULL,
    "image_object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "expected_byte_size" INTEGER,
    "device_id" TEXT,
    "status" "WeightProofCaptureStatus" NOT NULL DEFAULT 'CREATED',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "finalized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipping_weight_proof_capture_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_weight_proofs" (
    "id" TEXT NOT NULL,
    "capture_session_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "shipment_id" TEXT,
    "awb_number" TEXT NOT NULL,
    "declared_weight_grams" INTEGER NOT NULL,
    "length_cm" DECIMAL(10,2) NOT NULL,
    "width_cm" DECIMAL(10,2) NOT NULL,
    "height_cm" DECIMAL(10,2) NOT NULL,
    "volumetric_weight_grams" INTEGER NOT NULL,
    "chargeable_weight_grams" INTEGER NOT NULL,
    "image_object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "device_id" TEXT,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipping_weight_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipping_weight_proof_capture_sessions_merchant_id_awb_number_idx" ON "shipping_weight_proof_capture_sessions"("merchant_id", "awb_number");

-- CreateIndex
CREATE INDEX "shipping_weight_proof_capture_sessions_shipment_id_idx" ON "shipping_weight_proof_capture_sessions"("shipment_id");

-- CreateIndex
CREATE INDEX "shipping_weight_proof_capture_sessions_status_expires_at_idx" ON "shipping_weight_proof_capture_sessions"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipping_weight_proofs_capture_session_id_key" ON "shipping_weight_proofs"("capture_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipping_weight_proofs_merchant_id_awb_number_key" ON "shipping_weight_proofs"("merchant_id", "awb_number");

-- CreateIndex
CREATE INDEX "shipping_weight_proofs_shipment_id_idx" ON "shipping_weight_proofs"("shipment_id");

-- CreateIndex
CREATE INDEX "shipping_weight_proofs_created_at_idx" ON "shipping_weight_proofs"("created_at");

-- AddForeignKey
ALTER TABLE "shipping_weight_proof_capture_sessions" ADD CONSTRAINT "shipping_weight_proof_capture_sessions_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_weight_proofs" ADD CONSTRAINT "shipping_weight_proofs_capture_session_id_fkey" FOREIGN KEY ("capture_session_id") REFERENCES "shipping_weight_proof_capture_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_weight_proofs" ADD CONSTRAINT "shipping_weight_proofs_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
