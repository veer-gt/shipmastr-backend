-- CreateEnum
CREATE TYPE "public"."ReconciliationStatus" AS ENUM (
  'AUTO_APPROVED',
  'PARTIAL_MATCH',
  'COD_SHORTFALL',
  'COD_DELAYED',
  'INVOICE_MISMATCH',
  'WEIGHT_DISPUTE',
  'ZONE_DISPUTE',
  'DUPLICATE_BILLING',
  'MISSING_REMITTANCE',
  'RTO_CHARGE_REVIEW',
  'FAKE_ATTEMPT_REVIEW',
  'MANUAL_REVIEW',
  'PAYMENT_HOLD',
  'SETTLED'
);

-- CreateEnum
CREATE TYPE "public"."ReconciliationDisputeType" AS ENUM (
  'INVOICE_MISMATCH',
  'COD_SHORTFALL',
  'COD_DELAY',
  'DUPLICATE_BILLING',
  'UNKNOWN_AWB',
  'WEIGHT_DISPUTE',
  'ZONE_DISPUTE',
  'RTO_CHARGE_ISSUE',
  'FAKE_ATTEMPT_NDR_ISSUE'
);

-- CreateEnum
CREATE TYPE "public"."DisputeWorkflowStatus" AS ENUM (
  'OPEN',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'RESOLVED'
);

-- CreateEnum
CREATE TYPE "public"."PaymentHoldStatus" AS ENUM (
  'ACTIVE',
  'RELEASED',
  'CANCELLED'
);

-- CreateEnum
CREATE TYPE "public"."SellerSettlementStatus" AS ENUM (
  'PENDING',
  'BLOCKED',
  'APPROVED',
  'SETTLED'
);

-- AlterTable
ALTER TABLE "public"."RateCard"
  ADD COLUMN "gstPercent" DECIMAL(5,2) NOT NULL DEFAULT 18.00;

-- AlterTable
ALTER TABLE "public"."CourierInvoice"
  ADD COLUMN "invoiceNumber" TEXT,
  ADD COLUMN "totalAmount" DECIMAL(12,2),
  ADD COLUMN "gstAmount" DECIMAL(12,2),
  ADD COLUMN "metadata" JSONB;

-- CreateTable
CREATE TABLE "public"."CourierInvoiceLine" (
  "id" TEXT NOT NULL,
  "courierInvoiceId" TEXT NOT NULL,
  "merchantId" TEXT,
  "courierId" TEXT NOT NULL,
  "awb" TEXT,
  "orderId" TEXT,
  "externalOrderId" TEXT,
  "chargedWeightGrams" INTEGER,
  "billedWeightGrams" INTEGER,
  "zone" TEXT,
  "forwardFreight" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "rtoFreight" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "codFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "otherCharges" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "gstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "totalCharge" DECIMAL(12,2) NOT NULL,
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourierInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CodRemittance" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "courierId" TEXT,
  "awb" TEXT,
  "orderId" TEXT,
  "externalOrderId" TEXT,
  "codAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "remittedAmount" DECIMAL(12,2) NOT NULL,
  "remittedAt" TIMESTAMP(3),
  "utr" TEXT,
  "status" TEXT NOT NULL DEFAULT 'imported',
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CodRemittance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SellerWalletLedger" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "orderId" TEXT,
  "awb" TEXT,
  "entryType" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "balanceAfter" DECIMAL(12,2),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SellerWalletLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SellerSettlement" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "orderId" TEXT,
  "awb" TEXT,
  "reconciliationResultId" TEXT,
  "status" "public"."SellerSettlementStatus" NOT NULL DEFAULT 'PENDING',
  "codCollected" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "courierCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "platformFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "adjustmentAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "sellerPayable" DECIMAL(12,2) NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SellerSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReconciliationRun" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'COMPLETED',
  "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3),
  "totalResults" INTEGER NOT NULL DEFAULT 0,
  "autoApprovedCount" INTEGER NOT NULL DEFAULT 0,
  "disputeCount" INTEGER NOT NULL DEFAULT 0,
  "paymentHoldCount" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReconciliationResult" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "orderId" TEXT,
  "externalOrderId" TEXT,
  "awb" TEXT,
  "courierId" TEXT,
  "status" "public"."ReconciliationStatus" NOT NULL,
  "expectedCourierCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "invoicedCourierCharge" DECIMAL(12,2),
  "expectedCodAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "remittedCodAmount" DECIMAL(12,2),
  "sellerPayable" DECIMAL(12,2),
  "courierPayable" DECIMAL(12,2),
  "mismatchAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "disputeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "paymentHoldAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "reasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReconciliationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReconciliationDispute" (
  "id" TEXT NOT NULL,
  "reconciliationResultId" TEXT,
  "merchantId" TEXT,
  "courierId" TEXT,
  "awb" TEXT,
  "orderId" TEXT,
  "type" "public"."ReconciliationDisputeType" NOT NULL,
  "status" "public"."DisputeWorkflowStatus" NOT NULL DEFAULT 'OPEN',
  "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL,
  "evidence" JSONB,
  "resolution" JSONB,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReconciliationDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PaymentHold" (
  "id" TEXT NOT NULL,
  "reconciliationResultId" TEXT,
  "merchantId" TEXT NOT NULL,
  "orderId" TEXT,
  "awb" TEXT,
  "reason" TEXT NOT NULL,
  "status" "public"."PaymentHoldStatus" NOT NULL DEFAULT 'ACTIVE',
  "amount" DECIMAL(12,2) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PaymentHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateCard_gstPercent_idx" ON "public"."RateCard"("gstPercent");

-- CreateIndex
CREATE INDEX "CourierInvoice_invoiceNumber_idx" ON "public"."CourierInvoice"("invoiceNumber");
CREATE INDEX "CourierInvoiceLine_courierInvoiceId_idx" ON "public"."CourierInvoiceLine"("courierInvoiceId");
CREATE INDEX "CourierInvoiceLine_merchantId_idx" ON "public"."CourierInvoiceLine"("merchantId");
CREATE INDEX "CourierInvoiceLine_courierId_idx" ON "public"."CourierInvoiceLine"("courierId");
CREATE INDEX "CourierInvoiceLine_awb_idx" ON "public"."CourierInvoiceLine"("awb");
CREATE INDEX "CourierInvoiceLine_orderId_idx" ON "public"."CourierInvoiceLine"("orderId");
CREATE INDEX "CourierInvoiceLine_externalOrderId_idx" ON "public"."CourierInvoiceLine"("externalOrderId");

CREATE INDEX "CodRemittance_merchantId_idx" ON "public"."CodRemittance"("merchantId");
CREATE INDEX "CodRemittance_courierId_idx" ON "public"."CodRemittance"("courierId");
CREATE INDEX "CodRemittance_awb_idx" ON "public"."CodRemittance"("awb");
CREATE INDEX "CodRemittance_orderId_idx" ON "public"."CodRemittance"("orderId");
CREATE INDEX "CodRemittance_externalOrderId_idx" ON "public"."CodRemittance"("externalOrderId");
CREATE INDEX "CodRemittance_remittedAt_idx" ON "public"."CodRemittance"("remittedAt");

CREATE INDEX "SellerWalletLedger_merchantId_idx" ON "public"."SellerWalletLedger"("merchantId");
CREATE INDEX "SellerWalletLedger_orderId_idx" ON "public"."SellerWalletLedger"("orderId");
CREATE INDEX "SellerWalletLedger_awb_idx" ON "public"."SellerWalletLedger"("awb");
CREATE INDEX "SellerWalletLedger_entryType_idx" ON "public"."SellerWalletLedger"("entryType");
CREATE INDEX "SellerWalletLedger_createdAt_idx" ON "public"."SellerWalletLedger"("createdAt");

CREATE INDEX "SellerSettlement_merchantId_idx" ON "public"."SellerSettlement"("merchantId");
CREATE INDEX "SellerSettlement_orderId_idx" ON "public"."SellerSettlement"("orderId");
CREATE INDEX "SellerSettlement_awb_idx" ON "public"."SellerSettlement"("awb");
CREATE INDEX "SellerSettlement_reconciliationResultId_idx" ON "public"."SellerSettlement"("reconciliationResultId");
CREATE INDEX "SellerSettlement_status_idx" ON "public"."SellerSettlement"("status");

CREATE INDEX "ReconciliationRun_merchantId_idx" ON "public"."ReconciliationRun"("merchantId");
CREATE INDEX "ReconciliationRun_status_idx" ON "public"."ReconciliationRun"("status");
CREATE INDEX "ReconciliationRun_startedAt_idx" ON "public"."ReconciliationRun"("startedAt");

CREATE INDEX "ReconciliationResult_runId_idx" ON "public"."ReconciliationResult"("runId");
CREATE INDEX "ReconciliationResult_merchantId_idx" ON "public"."ReconciliationResult"("merchantId");
CREATE INDEX "ReconciliationResult_orderId_idx" ON "public"."ReconciliationResult"("orderId");
CREATE INDEX "ReconciliationResult_externalOrderId_idx" ON "public"."ReconciliationResult"("externalOrderId");
CREATE INDEX "ReconciliationResult_awb_idx" ON "public"."ReconciliationResult"("awb");
CREATE INDEX "ReconciliationResult_courierId_idx" ON "public"."ReconciliationResult"("courierId");
CREATE INDEX "ReconciliationResult_status_idx" ON "public"."ReconciliationResult"("status");
CREATE INDEX "ReconciliationResult_createdAt_idx" ON "public"."ReconciliationResult"("createdAt");

CREATE INDEX "ReconciliationDispute_reconciliationResultId_idx" ON "public"."ReconciliationDispute"("reconciliationResultId");
CREATE INDEX "ReconciliationDispute_merchantId_idx" ON "public"."ReconciliationDispute"("merchantId");
CREATE INDEX "ReconciliationDispute_courierId_idx" ON "public"."ReconciliationDispute"("courierId");
CREATE INDEX "ReconciliationDispute_awb_idx" ON "public"."ReconciliationDispute"("awb");
CREATE INDEX "ReconciliationDispute_orderId_idx" ON "public"."ReconciliationDispute"("orderId");
CREATE INDEX "ReconciliationDispute_type_idx" ON "public"."ReconciliationDispute"("type");
CREATE INDEX "ReconciliationDispute_status_idx" ON "public"."ReconciliationDispute"("status");
CREATE INDEX "ReconciliationDispute_createdAt_idx" ON "public"."ReconciliationDispute"("createdAt");

CREATE INDEX "PaymentHold_reconciliationResultId_idx" ON "public"."PaymentHold"("reconciliationResultId");
CREATE INDEX "PaymentHold_merchantId_idx" ON "public"."PaymentHold"("merchantId");
CREATE INDEX "PaymentHold_orderId_idx" ON "public"."PaymentHold"("orderId");
CREATE INDEX "PaymentHold_awb_idx" ON "public"."PaymentHold"("awb");
CREATE INDEX "PaymentHold_status_idx" ON "public"."PaymentHold"("status");
CREATE INDEX "PaymentHold_createdAt_idx" ON "public"."PaymentHold"("createdAt");

-- AddForeignKey
ALTER TABLE "public"."CourierInvoiceLine"
  ADD CONSTRAINT "CourierInvoiceLine_courierInvoiceId_fkey"
  FOREIGN KEY ("courierInvoiceId") REFERENCES "public"."CourierInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."SellerSettlement"
  ADD CONSTRAINT "SellerSettlement_reconciliationResultId_fkey"
  FOREIGN KEY ("reconciliationResultId") REFERENCES "public"."ReconciliationResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."ReconciliationResult"
  ADD CONSTRAINT "ReconciliationResult_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "public"."ReconciliationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."ReconciliationDispute"
  ADD CONSTRAINT "ReconciliationDispute_reconciliationResultId_fkey"
  FOREIGN KEY ("reconciliationResultId") REFERENCES "public"."ReconciliationResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."PaymentHold"
  ADD CONSTRAINT "PaymentHold_reconciliationResultId_fkey"
  FOREIGN KEY ("reconciliationResultId") REFERENCES "public"."ReconciliationResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;
