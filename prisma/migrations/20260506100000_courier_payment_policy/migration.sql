-- CreateEnum
CREATE TYPE "public"."CourierSettlementFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "public"."CourierPenaltyType" AS ENUM ('COD_REMITTANCE_DELAY');

-- CreateEnum
CREATE TYPE "public"."CourierPenaltyStatus" AS ENUM ('CALCULATED', 'APPLIED', 'WAIVED');

-- CreateEnum
CREATE TYPE "public"."FinanceApprovalType" AS ENUM ('SELLER_SETTLEMENT', 'PAYMENT_HOLD_RELEASE', 'COURIER_SETTLEMENT');

-- CreateEnum
CREATE TYPE "public"."FinanceApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."CourierFinancePolicy" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "courierId" TEXT NOT NULL,
  "creditPeriodDays" INTEGER NOT NULL DEFAULT 7,
  "codRemittanceSlaDays" INTEGER NOT NULL DEFAULT 7,
  "penaltyGraceDays" INTEGER NOT NULL DEFAULT 0,
  "codDelayPenaltyRateBps" INTEGER NOT NULL DEFAULT 50,
  "codDelayPenaltyFixedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "maxCodDelayPenaltyAmount" DECIMAL(12,2),
  "settlementFrequency" "public"."CourierSettlementFrequency" NOT NULL DEFAULT 'WEEKLY',
  "settlementAnchorDay" INTEGER NOT NULL DEFAULT 5,
  "makerCheckerRequired" BOOLEAN NOT NULL DEFAULT true,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourierFinancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CourierPenalty" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "courierId" TEXT NOT NULL,
  "reconciliationResultId" TEXT,
  "awb" TEXT,
  "orderId" TEXT,
  "penaltyType" "public"."CourierPenaltyType" NOT NULL,
  "status" "public"."CourierPenaltyStatus" NOT NULL DEFAULT 'CALCULATED',
  "baseAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "penaltyAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "delayedDays" INTEGER NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL,
  "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3),
  "waivedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourierPenalty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FinanceApprovalRequest" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "approvalType" "public"."FinanceApprovalType" NOT NULL,
  "status" "public"."FinanceApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "settlementId" TEXT,
  "paymentHoldId" TEXT,
  "courierId" TEXT,
  "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "checkedBy" TEXT,
  "checkedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FinanceApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PaymentBlockNote" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "paymentHoldId" TEXT,
  "settlementId" TEXT,
  "approvalId" TEXT,
  "courierId" TEXT,
  "reasonCode" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PaymentBlockNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CourierFinancePolicy_merchantId_courierId_key" ON "public"."CourierFinancePolicy"("merchantId", "courierId");
CREATE INDEX "CourierFinancePolicy_merchantId_idx" ON "public"."CourierFinancePolicy"("merchantId");
CREATE INDEX "CourierFinancePolicy_courierId_idx" ON "public"."CourierFinancePolicy"("courierId");
CREATE INDEX "CourierFinancePolicy_active_idx" ON "public"."CourierFinancePolicy"("active");

CREATE UNIQUE INDEX "CourierPenalty_reconciliationResultId_penaltyType_key" ON "public"."CourierPenalty"("reconciliationResultId", "penaltyType");
CREATE INDEX "CourierPenalty_merchantId_idx" ON "public"."CourierPenalty"("merchantId");
CREATE INDEX "CourierPenalty_courierId_idx" ON "public"."CourierPenalty"("courierId");
CREATE INDEX "CourierPenalty_penaltyType_idx" ON "public"."CourierPenalty"("penaltyType");
CREATE INDEX "CourierPenalty_status_idx" ON "public"."CourierPenalty"("status");
CREATE INDEX "CourierPenalty_calculatedAt_idx" ON "public"."CourierPenalty"("calculatedAt");

CREATE INDEX "FinanceApprovalRequest_merchantId_idx" ON "public"."FinanceApprovalRequest"("merchantId");
CREATE INDEX "FinanceApprovalRequest_approvalType_idx" ON "public"."FinanceApprovalRequest"("approvalType");
CREATE INDEX "FinanceApprovalRequest_status_idx" ON "public"."FinanceApprovalRequest"("status");
CREATE INDEX "FinanceApprovalRequest_settlementId_idx" ON "public"."FinanceApprovalRequest"("settlementId");
CREATE INDEX "FinanceApprovalRequest_paymentHoldId_idx" ON "public"."FinanceApprovalRequest"("paymentHoldId");
CREATE INDEX "FinanceApprovalRequest_courierId_idx" ON "public"."FinanceApprovalRequest"("courierId");
CREATE INDEX "FinanceApprovalRequest_requestedAt_idx" ON "public"."FinanceApprovalRequest"("requestedAt");

CREATE INDEX "PaymentBlockNote_merchantId_idx" ON "public"."PaymentBlockNote"("merchantId");
CREATE INDEX "PaymentBlockNote_paymentHoldId_idx" ON "public"."PaymentBlockNote"("paymentHoldId");
CREATE INDEX "PaymentBlockNote_settlementId_idx" ON "public"."PaymentBlockNote"("settlementId");
CREATE INDEX "PaymentBlockNote_approvalId_idx" ON "public"."PaymentBlockNote"("approvalId");
CREATE INDEX "PaymentBlockNote_courierId_idx" ON "public"."PaymentBlockNote"("courierId");
CREATE INDEX "PaymentBlockNote_reasonCode_idx" ON "public"."PaymentBlockNote"("reasonCode");
CREATE INDEX "PaymentBlockNote_createdAt_idx" ON "public"."PaymentBlockNote"("createdAt");

-- AddForeignKey
ALTER TABLE "public"."CourierFinancePolicy"
  ADD CONSTRAINT "CourierFinancePolicy_courierId_fkey"
  FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."CourierPenalty"
  ADD CONSTRAINT "CourierPenalty_courierId_fkey"
  FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."CourierPenalty"
  ADD CONSTRAINT "CourierPenalty_reconciliationResultId_fkey"
  FOREIGN KEY ("reconciliationResultId") REFERENCES "public"."ReconciliationResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;
