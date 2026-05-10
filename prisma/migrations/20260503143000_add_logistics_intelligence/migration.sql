CREATE TYPE "public"."RiskDecisionType" AS ENUM ('ALLOW', 'OTP_REQUIRED', 'PREPAID_ONLY', 'HOLD', 'BLOCK');
CREATE TYPE "public"."CodDecision" AS ENUM ('ALLOW_COD', 'REQUIRE_OTP', 'PREPAID_ONLY', 'MANUAL_REVIEW');
CREATE TYPE "public"."TrustTier" AS ENUM ('NEW', 'WATCHLIST', 'TRUSTED', 'PREFERRED', 'RISKY', 'SUSPENDED');
CREATE TYPE "public"."CourierEventType" AS ENUM ('PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'NDR', 'RTO', 'LOST', 'CANCELLED');
CREATE TYPE "public"."NdrReason" AS ENUM ('CUSTOMER_NOT_REACHABLE', 'ADDRESS_ISSUE', 'CUSTOMER_REFUSED', 'PAYMENT_ISSUE', 'RESCHEDULE_REQUESTED', 'OTHER');
CREATE TYPE "public"."RtoReason" AS ENUM ('FAILED_DELIVERY', 'CUSTOMER_REFUSED', 'ADDRESS_INCOMPLETE', 'CUSTOMER_UNREACHABLE', 'COURIER_ISSUE', 'OTHER');
CREATE TYPE "public"."SlaBreachType" AS ENUM ('AWB_GENERATION_FAILED', 'PICKUP_DELAYED', 'WEBHOOK_DELAYED', 'TRACKING_STALE', 'NDR_ACTION_DELAYED', 'COD_REMITTANCE_DELAYED', 'LEDGER_MISMATCH');

ALTER TABLE "public"."User" ADD COLUMN "firebaseUid" TEXT;
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "public"."User"("firebaseUid");
CREATE INDEX "User_firebaseUid_idx" ON "public"."User"("firebaseUid");

CREATE TABLE "public"."MerchantMetrics" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "totalOrders" INTEGER NOT NULL DEFAULT 0,
  "codOrders" INTEGER NOT NULL DEFAULT 0,
  "prepaidOrders" INTEGER NOT NULL DEFAULT 0,
  "deliveredOrders" INTEGER NOT NULL DEFAULT 0,
  "ndrOrders" INTEGER NOT NULL DEFAULT 0,
  "rtoOrders" INTEGER NOT NULL DEFAULT 0,
  "fraudSignalCount" INTEGER NOT NULL DEFAULT 0,
  "codExposure" NUMERIC(12,2) NOT NULL DEFAULT 0,
  "orderValueTotal" NUMERIC(12,2) NOT NULL DEFAULT 0,
  "rtoRate" NUMERIC(5,4) NOT NULL DEFAULT 0,
  "ndrRate" NUMERIC(5,4) NOT NULL DEFAULT 0,
  "deliveryRate" NUMERIC(5,4) NOT NULL DEFAULT 0,
  "trustScore" INTEGER NOT NULL DEFAULT 50,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchantMetrics_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."PincodeIntelligence" (
  "id" TEXT NOT NULL,
  "pincode" TEXT NOT NULL,
  "totalOrders" INTEGER NOT NULL DEFAULT 0,
  "deliveredOrders" INTEGER NOT NULL DEFAULT 0,
  "ndrOrders" INTEGER NOT NULL DEFAULT 0,
  "rtoOrders" INTEGER NOT NULL DEFAULT 0,
  "fraudSignalCount" INTEGER NOT NULL DEFAULT 0,
  "addressConfidence" INTEGER NOT NULL DEFAULT 70,
  "deliveryRate" NUMERIC(5,4) NOT NULL DEFAULT 0,
  "rtoRate" NUMERIC(5,4) NOT NULL DEFAULT 0,
  "ndrRate" NUMERIC(5,4) NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PincodeIntelligence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."AddressFingerprint" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "addressHash" TEXT NOT NULL,
  "pincode" TEXT NOT NULL,
  "totalOrders" INTEGER NOT NULL DEFAULT 0,
  "deliveredOrders" INTEGER NOT NULL DEFAULT 0,
  "ndrOrders" INTEGER NOT NULL DEFAULT 0,
  "rtoOrders" INTEGER NOT NULL DEFAULT 0,
  "fraudSignalCount" INTEGER NOT NULL DEFAULT 0,
  "confidenceScore" INTEGER NOT NULL DEFAULT 70,
  "riskLevel" "public"."RiskLevel" NOT NULL DEFAULT 'LOW',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AddressFingerprint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."BuyerBehaviourProfile" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "phoneHash" TEXT NOT NULL,
  "totalOrders" INTEGER NOT NULL DEFAULT 0,
  "codOrders" INTEGER NOT NULL DEFAULT 0,
  "prepaidOrders" INTEGER NOT NULL DEFAULT 0,
  "deliveredOrders" INTEGER NOT NULL DEFAULT 0,
  "ndrOrders" INTEGER NOT NULL DEFAULT 0,
  "rtoOrders" INTEGER NOT NULL DEFAULT 0,
  "fraudSignalCount" INTEGER NOT NULL DEFAULT 0,
  "riskScore" INTEGER NOT NULL DEFAULT 20,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BuyerBehaviourProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CodBehaviourProfile" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "phoneHash" TEXT NOT NULL,
  "totalCodOrders" INTEGER NOT NULL DEFAULT 0,
  "deliveredCodOrders" INTEGER NOT NULL DEFAULT 0,
  "rtoCodOrders" INTEGER NOT NULL DEFAULT 0,
  "otpRequiredCount" INTEGER NOT NULL DEFAULT 0,
  "prepaidOnlyCount" INTEGER NOT NULL DEFAULT 0,
  "codExposure" NUMERIC(12,2) NOT NULL DEFAULT 0,
  "codSuccessRate" NUMERIC(5,4) NOT NULL DEFAULT 0,
  "decision" "public"."CodDecision" NOT NULL DEFAULT 'ALLOW_COD',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CodBehaviourProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierPincodePerformance" (
  "id" TEXT NOT NULL,
  "courierId" TEXT NOT NULL,
  "pincode" TEXT NOT NULL,
  "totalShipments" INTEGER NOT NULL DEFAULT 0,
  "deliveredCount" INTEGER NOT NULL DEFAULT 0,
  "ndrCount" INTEGER NOT NULL DEFAULT 0,
  "rtoCount" INTEGER NOT NULL DEFAULT 0,
  "lostCount" INTEGER NOT NULL DEFAULT 0,
  "avgDeliveryDays" NUMERIC(6,2) NOT NULL DEFAULT 0,
  "deliveryRate" NUMERIC(5,4) NOT NULL DEFAULT 0,
  "rtoRate" NUMERIC(5,4) NOT NULL DEFAULT 0,
  "score" INTEGER NOT NULL DEFAULT 50,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourierPincodePerformance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierScorecard" (
  "id" TEXT NOT NULL,
  "courierId" TEXT NOT NULL,
  "shipmentCount" INTEGER NOT NULL DEFAULT 0,
  "deliveredCount" INTEGER NOT NULL DEFAULT 0,
  "ndrCount" INTEGER NOT NULL DEFAULT 0,
  "rtoCount" INTEGER NOT NULL DEFAULT 0,
  "lostCount" INTEGER NOT NULL DEFAULT 0,
  "avgDeliveryDays" NUMERIC(6,2) NOT NULL DEFAULT 0,
  "deliveryRate" NUMERIC(5,4) NOT NULL DEFAULT 0,
  "rtoRate" NUMERIC(5,4) NOT NULL DEFAULT 0,
  "codDelayDays" NUMERIC(6,2) NOT NULL DEFAULT 0,
  "score" INTEGER NOT NULL DEFAULT 50,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourierScorecard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."MerchantTrustProfile" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "tier" "public"."TrustTier" NOT NULL DEFAULT 'NEW',
  "trustScore" INTEGER NOT NULL DEFAULT 50,
  "totalOrders" INTEGER NOT NULL DEFAULT 0,
  "rtoRate" NUMERIC(5,4) NOT NULL DEFAULT 0,
  "ndrRate" NUMERIC(5,4) NOT NULL DEFAULT 0,
  "codExposure" NUMERIC(12,2) NOT NULL DEFAULT 0,
  "reliabilityScore" INTEGER NOT NULL DEFAULT 70,
  "reasons" JSONB,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchantTrustProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."MerchantTrustEvent" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "orderId" TEXT,
  "tierBefore" "public"."TrustTier",
  "tierAfter" "public"."TrustTier" NOT NULL,
  "scoreBefore" INTEGER,
  "scoreAfter" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MerchantTrustEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CodRemittanceLedger" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "orderId" TEXT,
  "courierId" TEXT,
  "amount" NUMERIC(12,2) NOT NULL DEFAULT 0,
  "remittedAmount" NUMERIC(12,2) NOT NULL DEFAULT 0,
  "deductions" NUMERIC(12,2) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "expectedAt" TIMESTAMP(3),
  "remittedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CodRemittanceLedger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CodVerificationAttempt" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "orderId" TEXT,
  "phoneHash" TEXT NOT NULL,
  "decision" "public"."CodDecision" NOT NULL,
  "riskLevel" "public"."RiskLevel" NOT NULL,
  "success" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CodVerificationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."NdrEvent" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "orderId" TEXT,
  "courierId" TEXT,
  "pincode" TEXT,
  "phoneHash" TEXT,
  "addressHash" TEXT,
  "reason" "public"."NdrReason" NOT NULL DEFAULT 'OTHER',
  "actionRequired" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NdrEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."RtoEvent" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "orderId" TEXT,
  "courierId" TEXT,
  "pincode" TEXT,
  "phoneHash" TEXT,
  "addressHash" TEXT,
  "reason" "public"."RtoReason" NOT NULL DEFAULT 'OTHER',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RtoEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."FraudSignal" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "orderId" TEXT,
  "phoneHash" TEXT,
  "addressHash" TEXT,
  "pincode" TEXT,
  "riskLevel" "public"."RiskLevel" NOT NULL,
  "score" INTEGER NOT NULL DEFAULT 0,
  "signalType" TEXT NOT NULL,
  "reasons" JSONB,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FraudSignal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."RiskDecisionRecord" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "phoneHash" TEXT,
  "addressHash" TEXT,
  "riskLevel" "public"."RiskLevel" NOT NULL,
  "decision" "public"."RiskDecisionType" NOT NULL,
  "codDecision" "public"."CodDecision",
  "riskScore" INTEGER NOT NULL DEFAULT 0,
  "addressConfidence" INTEGER NOT NULL DEFAULT 70,
  "reasons" JSONB,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RiskDecisionRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierRecommendation" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "courierId" TEXT,
  "pincode" TEXT NOT NULL,
  "score" INTEGER NOT NULL DEFAULT 0,
  "estimatedCost" NUMERIC(12,2),
  "estimatedEtaDays" INTEGER,
  "reasons" JSONB,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourierRecommendation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."OperationalEvent" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT,
  "orderId" TEXT,
  "courierId" TEXT,
  "eventType" "public"."CourierEventType",
  "status" TEXT NOT NULL,
  "severity" "public"."RiskLevel" NOT NULL DEFAULT 'LOW',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OperationalEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."SlaBreach" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT,
  "orderId" TEXT,
  "courierId" TEXT,
  "breachType" "public"."SlaBreachType" NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "severity" "public"."RiskLevel" NOT NULL DEFAULT 'MEDIUM',
  "resolvedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SlaBreach_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MerchantMetrics_merchantId_key" ON "public"."MerchantMetrics"("merchantId");
CREATE INDEX "MerchantMetrics_merchantId_idx" ON "public"."MerchantMetrics"("merchantId");
CREATE INDEX "MerchantMetrics_createdAt_idx" ON "public"."MerchantMetrics"("createdAt");
CREATE UNIQUE INDEX "PincodeIntelligence_pincode_key" ON "public"."PincodeIntelligence"("pincode");
CREATE INDEX "PincodeIntelligence_pincode_idx" ON "public"."PincodeIntelligence"("pincode");
CREATE INDEX "PincodeIntelligence_createdAt_idx" ON "public"."PincodeIntelligence"("createdAt");
CREATE UNIQUE INDEX "AddressFingerprint_merchantId_addressHash_key" ON "public"."AddressFingerprint"("merchantId", "addressHash");
CREATE INDEX "AddressFingerprint_merchantId_idx" ON "public"."AddressFingerprint"("merchantId");
CREATE INDEX "AddressFingerprint_pincode_idx" ON "public"."AddressFingerprint"("pincode");
CREATE INDEX "AddressFingerprint_addressHash_idx" ON "public"."AddressFingerprint"("addressHash");
CREATE INDEX "AddressFingerprint_createdAt_idx" ON "public"."AddressFingerprint"("createdAt");
CREATE UNIQUE INDEX "BuyerBehaviourProfile_merchantId_phoneHash_key" ON "public"."BuyerBehaviourProfile"("merchantId", "phoneHash");
CREATE INDEX "BuyerBehaviourProfile_merchantId_idx" ON "public"."BuyerBehaviourProfile"("merchantId");
CREATE INDEX "BuyerBehaviourProfile_phoneHash_idx" ON "public"."BuyerBehaviourProfile"("phoneHash");
CREATE INDEX "BuyerBehaviourProfile_createdAt_idx" ON "public"."BuyerBehaviourProfile"("createdAt");
CREATE UNIQUE INDEX "CodBehaviourProfile_merchantId_phoneHash_key" ON "public"."CodBehaviourProfile"("merchantId", "phoneHash");
CREATE INDEX "CodBehaviourProfile_merchantId_idx" ON "public"."CodBehaviourProfile"("merchantId");
CREATE INDEX "CodBehaviourProfile_phoneHash_idx" ON "public"."CodBehaviourProfile"("phoneHash");
CREATE INDEX "CodBehaviourProfile_createdAt_idx" ON "public"."CodBehaviourProfile"("createdAt");
CREATE UNIQUE INDEX "CourierPincodePerformance_courierId_pincode_key" ON "public"."CourierPincodePerformance"("courierId", "pincode");
CREATE INDEX "CourierPincodePerformance_courierId_idx" ON "public"."CourierPincodePerformance"("courierId");
CREATE INDEX "CourierPincodePerformance_pincode_idx" ON "public"."CourierPincodePerformance"("pincode");
CREATE INDEX "CourierPincodePerformance_createdAt_idx" ON "public"."CourierPincodePerformance"("createdAt");
CREATE UNIQUE INDEX "CourierScorecard_courierId_key" ON "public"."CourierScorecard"("courierId");
CREATE INDEX "CourierScorecard_courierId_idx" ON "public"."CourierScorecard"("courierId");
CREATE INDEX "CourierScorecard_createdAt_idx" ON "public"."CourierScorecard"("createdAt");
CREATE UNIQUE INDEX "MerchantTrustProfile_merchantId_key" ON "public"."MerchantTrustProfile"("merchantId");
CREATE INDEX "MerchantTrustProfile_merchantId_idx" ON "public"."MerchantTrustProfile"("merchantId");
CREATE INDEX "MerchantTrustProfile_tier_idx" ON "public"."MerchantTrustProfile"("tier");
CREATE INDEX "MerchantTrustProfile_createdAt_idx" ON "public"."MerchantTrustProfile"("createdAt");
CREATE INDEX "MerchantTrustEvent_merchantId_idx" ON "public"."MerchantTrustEvent"("merchantId");
CREATE INDEX "MerchantTrustEvent_orderId_idx" ON "public"."MerchantTrustEvent"("orderId");
CREATE INDEX "MerchantTrustEvent_createdAt_idx" ON "public"."MerchantTrustEvent"("createdAt");
CREATE INDEX "CodRemittanceLedger_merchantId_idx" ON "public"."CodRemittanceLedger"("merchantId");
CREATE INDEX "CodRemittanceLedger_orderId_idx" ON "public"."CodRemittanceLedger"("orderId");
CREATE INDEX "CodRemittanceLedger_courierId_idx" ON "public"."CodRemittanceLedger"("courierId");
CREATE INDEX "CodRemittanceLedger_createdAt_idx" ON "public"."CodRemittanceLedger"("createdAt");
CREATE INDEX "CodVerificationAttempt_merchantId_idx" ON "public"."CodVerificationAttempt"("merchantId");
CREATE INDEX "CodVerificationAttempt_orderId_idx" ON "public"."CodVerificationAttempt"("orderId");
CREATE INDEX "CodVerificationAttempt_phoneHash_idx" ON "public"."CodVerificationAttempt"("phoneHash");
CREATE INDEX "CodVerificationAttempt_createdAt_idx" ON "public"."CodVerificationAttempt"("createdAt");
CREATE INDEX "NdrEvent_merchantId_idx" ON "public"."NdrEvent"("merchantId");
CREATE INDEX "NdrEvent_orderId_idx" ON "public"."NdrEvent"("orderId");
CREATE INDEX "NdrEvent_courierId_idx" ON "public"."NdrEvent"("courierId");
CREATE INDEX "NdrEvent_pincode_idx" ON "public"."NdrEvent"("pincode");
CREATE INDEX "NdrEvent_phoneHash_idx" ON "public"."NdrEvent"("phoneHash");
CREATE INDEX "NdrEvent_addressHash_idx" ON "public"."NdrEvent"("addressHash");
CREATE INDEX "NdrEvent_createdAt_idx" ON "public"."NdrEvent"("createdAt");
CREATE INDEX "RtoEvent_merchantId_idx" ON "public"."RtoEvent"("merchantId");
CREATE INDEX "RtoEvent_orderId_idx" ON "public"."RtoEvent"("orderId");
CREATE INDEX "RtoEvent_courierId_idx" ON "public"."RtoEvent"("courierId");
CREATE INDEX "RtoEvent_pincode_idx" ON "public"."RtoEvent"("pincode");
CREATE INDEX "RtoEvent_phoneHash_idx" ON "public"."RtoEvent"("phoneHash");
CREATE INDEX "RtoEvent_addressHash_idx" ON "public"."RtoEvent"("addressHash");
CREATE INDEX "RtoEvent_createdAt_idx" ON "public"."RtoEvent"("createdAt");
CREATE INDEX "FraudSignal_merchantId_idx" ON "public"."FraudSignal"("merchantId");
CREATE INDEX "FraudSignal_orderId_idx" ON "public"."FraudSignal"("orderId");
CREATE INDEX "FraudSignal_pincode_idx" ON "public"."FraudSignal"("pincode");
CREATE INDEX "FraudSignal_phoneHash_idx" ON "public"."FraudSignal"("phoneHash");
CREATE INDEX "FraudSignal_addressHash_idx" ON "public"."FraudSignal"("addressHash");
CREATE INDEX "FraudSignal_createdAt_idx" ON "public"."FraudSignal"("createdAt");
CREATE INDEX "RiskDecisionRecord_merchantId_idx" ON "public"."RiskDecisionRecord"("merchantId");
CREATE INDEX "RiskDecisionRecord_orderId_idx" ON "public"."RiskDecisionRecord"("orderId");
CREATE INDEX "RiskDecisionRecord_phoneHash_idx" ON "public"."RiskDecisionRecord"("phoneHash");
CREATE INDEX "RiskDecisionRecord_addressHash_idx" ON "public"."RiskDecisionRecord"("addressHash");
CREATE INDEX "RiskDecisionRecord_createdAt_idx" ON "public"."RiskDecisionRecord"("createdAt");
CREATE INDEX "CourierRecommendation_merchantId_idx" ON "public"."CourierRecommendation"("merchantId");
CREATE INDEX "CourierRecommendation_orderId_idx" ON "public"."CourierRecommendation"("orderId");
CREATE INDEX "CourierRecommendation_courierId_idx" ON "public"."CourierRecommendation"("courierId");
CREATE INDEX "CourierRecommendation_pincode_idx" ON "public"."CourierRecommendation"("pincode");
CREATE INDEX "CourierRecommendation_createdAt_idx" ON "public"."CourierRecommendation"("createdAt");
CREATE INDEX "OperationalEvent_merchantId_idx" ON "public"."OperationalEvent"("merchantId");
CREATE INDEX "OperationalEvent_orderId_idx" ON "public"."OperationalEvent"("orderId");
CREATE INDEX "OperationalEvent_courierId_idx" ON "public"."OperationalEvent"("courierId");
CREATE INDEX "OperationalEvent_createdAt_idx" ON "public"."OperationalEvent"("createdAt");
CREATE INDEX "SlaBreach_merchantId_idx" ON "public"."SlaBreach"("merchantId");
CREATE INDEX "SlaBreach_orderId_idx" ON "public"."SlaBreach"("orderId");
CREATE INDEX "SlaBreach_courierId_idx" ON "public"."SlaBreach"("courierId");
CREATE INDEX "SlaBreach_createdAt_idx" ON "public"."SlaBreach"("createdAt");
