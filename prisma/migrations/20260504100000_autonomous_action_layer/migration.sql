CREATE TYPE "public"."AutonomousActionType" AS ENUM (
  'SEND_COD_OTP',
  'SEND_ADDRESS_CORRECTION_LINK',
  'HIDE_COD',
  'SEND_PREPAID_LINK',
  'AUTO_SELECT_COURIER',
  'HOLD_SHIPMENT',
  'RELEASE_SHIPMENT',
  'REQUEST_NDR_REATTEMPT',
  'SEND_NDR_RECOVERY_MESSAGE',
  'ESCALATE_INTERNAL_REVIEW',
  'REQUEST_SELLER_APPROVAL'
);

CREATE TYPE "public"."AutomationLevel" AS ENUM (
  'AUTO_EXECUTE',
  'AUTO_EXECUTE_NOTIFY',
  'REQUIRE_SELLER_APPROVAL',
  'REQUIRE_INTERNAL_REVIEW'
);

CREATE TYPE "public"."AutonomousActionStatus" AS ENUM (
  'PENDING',
  'EXECUTED',
  'FAILED',
  'CANCELLED',
  'APPROVED',
  'REJECTED',
  'EXPIRED'
);

CREATE TYPE "public"."CommunicationChannel" AS ENUM (
  'WHATSAPP',
  'SMS',
  'EMAIL',
  'CALL'
);

CREATE TABLE "public"."MerchantAutomationPolicy" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "autoCodControlEnabled" BOOLEAN NOT NULL DEFAULT true,
  "autoOtpForBronzeEnabled" BOOLEAN NOT NULL DEFAULT true,
  "autoPrepaidOnlyForIronEnabled" BOOLEAN NOT NULL DEFAULT false,
  "autoAddressCorrectionEnabled" BOOLEAN NOT NULL DEFAULT true,
  "autoCourierSelectionEnabled" BOOLEAN NOT NULL DEFAULT true,
  "autoNdrRecoveryEnabled" BOOLEAN NOT NULL DEFAULT true,
  "autoRtoHoldEnabled" BOOLEAN NOT NULL DEFAULT false,
  "autoCancelAfterFailedVerificationEnabled" BOOLEAN NOT NULL DEFAULT false,
  "maxAutoHoldOrderValue" NUMERIC(12,2),
  "maxAutoCourierCostIncrease" NUMERIC(12,2),
  "maxAutoCodAmount" NUMERIC(12,2),
  "allowPrepaidConversionMessage" BOOLEAN NOT NULL DEFAULT true,
  "allowBuyerWhatsappMessages" BOOLEAN NOT NULL DEFAULT true,
  "allowBuyerSmsMessages" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchantAutomationPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."AutonomousAction" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "actionType" "public"."AutonomousActionType" NOT NULL,
  "automationLevel" "public"."AutomationLevel" NOT NULL,
  "status" "public"."AutonomousActionStatus" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT NOT NULL,
  "inputSnapshot" JSONB,
  "resultSnapshot" JSONB,
  "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
  "approvedBy" TEXT,
  "approvedAt" TIMESTAMP(3),
  "executedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutonomousAction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."BuyerCommunicationEvent" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "phoneHash" TEXT,
  "channel" "public"."CommunicationChannel" NOT NULL,
  "template" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "response" TEXT,
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),
  "respondedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BuyerCommunicationEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."ActionOutcome" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "actionType" "public"."AutonomousActionType" NOT NULL,
  "expectedOutcome" TEXT NOT NULL,
  "actualOutcome" TEXT,
  "worked" BOOLEAN,
  "cost" NUMERIC(12,2),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ActionOutcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MerchantAutomationPolicy_merchantId_key" ON "public"."MerchantAutomationPolicy"("merchantId");
CREATE INDEX "MerchantAutomationPolicy_merchantId_idx" ON "public"."MerchantAutomationPolicy"("merchantId");

CREATE INDEX "AutonomousAction_orderId_idx" ON "public"."AutonomousAction"("orderId");
CREATE INDEX "AutonomousAction_merchantId_idx" ON "public"."AutonomousAction"("merchantId");
CREATE INDEX "AutonomousAction_actionType_idx" ON "public"."AutonomousAction"("actionType");
CREATE INDEX "AutonomousAction_status_idx" ON "public"."AutonomousAction"("status");
CREATE INDEX "AutonomousAction_automationLevel_idx" ON "public"."AutonomousAction"("automationLevel");
CREATE INDEX "AutonomousAction_createdAt_idx" ON "public"."AutonomousAction"("createdAt");

CREATE INDEX "BuyerCommunicationEvent_orderId_idx" ON "public"."BuyerCommunicationEvent"("orderId");
CREATE INDEX "BuyerCommunicationEvent_merchantId_idx" ON "public"."BuyerCommunicationEvent"("merchantId");
CREATE INDEX "BuyerCommunicationEvent_phoneHash_idx" ON "public"."BuyerCommunicationEvent"("phoneHash");
CREATE INDEX "BuyerCommunicationEvent_channel_idx" ON "public"."BuyerCommunicationEvent"("channel");
CREATE INDEX "BuyerCommunicationEvent_status_idx" ON "public"."BuyerCommunicationEvent"("status");
CREATE INDEX "BuyerCommunicationEvent_createdAt_idx" ON "public"."BuyerCommunicationEvent"("createdAt");

CREATE INDEX "ActionOutcome_orderId_idx" ON "public"."ActionOutcome"("orderId");
CREATE INDEX "ActionOutcome_merchantId_idx" ON "public"."ActionOutcome"("merchantId");
CREATE INDEX "ActionOutcome_actionType_idx" ON "public"."ActionOutcome"("actionType");
CREATE INDEX "ActionOutcome_worked_idx" ON "public"."ActionOutcome"("worked");
CREATE INDEX "ActionOutcome_createdAt_idx" ON "public"."ActionOutcome"("createdAt");

ALTER TABLE "public"."AutonomousAction" ADD CONSTRAINT "AutonomousAction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."BuyerCommunicationEvent" ADD CONSTRAINT "BuyerCommunicationEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."ActionOutcome" ADD CONSTRAINT "ActionOutcome_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
