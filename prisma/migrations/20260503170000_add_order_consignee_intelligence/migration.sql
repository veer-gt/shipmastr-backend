CREATE TYPE "public"."ConsigneeTier" AS ENUM ('GOLD', 'SILVER', 'BRONZE', 'IRON');
CREATE TYPE "public"."ShipmentDecision" AS ENUM ('SHIP', 'VERIFY_BEFORE_SHIP', 'HOLD', 'DO_NOT_SHIP');

CREATE TABLE "public"."ShipmentDetails" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "courierId" TEXT,
  "awb" TEXT,
  "trackingNumber" TEXT,
  "pincode" TEXT NOT NULL,
  "city" TEXT,
  "state" TEXT,
  "addressHash" TEXT,
  "shipmentStatus" TEXT NOT NULL DEFAULT 'CREATED',
  "pickupStatus" TEXT,
  "deliveryStatus" TEXT,
  "ndrStatus" TEXT,
  "rtoStatus" TEXT,
  "weightGrams" INTEGER,
  "volumetricWeight" NUMERIC(12,2),
  "zone" TEXT,
  "shippingCharge" NUMERIC(12,2),
  "codCharge" NUMERIC(12,2),
  "rtoCharge" NUMERIC(12,2),
  "estimatedDeliveryDate" TIMESTAMP(3),
  "actualDeliveryDate" TIMESTAMP(3),
  "firstAttemptAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "rtoInitiatedAt" TIMESTAMP(3),
  "rtoDeliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShipmentDetails_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."OrderIntelligence" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "buyerPhoneHash" TEXT,
  "addressHash" TEXT,
  "pincode" TEXT,
  "consigneeScore" INTEGER NOT NULL DEFAULT 50,
  "consigneeTier" "public"."ConsigneeTier" NOT NULL DEFAULT 'SILVER',
  "consigneeReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "merchantTrustScore" INTEGER NOT NULL DEFAULT 50,
  "merchantTrustTier" "public"."TrustTier",
  "merchantReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "courierId" TEXT,
  "courierScore" INTEGER,
  "courierReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "addressConfidenceScore" INTEGER,
  "pincodeRiskScore" INTEGER,
  "codRiskScore" INTEGER,
  "rtoRiskScore" INTEGER,
  "fraudRiskScore" INTEGER,
  "overallRiskScore" INTEGER,
  "codDecision" "public"."CodDecision" NOT NULL DEFAULT 'ALLOW_COD',
  "shipmentDecision" "public"."ShipmentDecision" NOT NULL DEFAULT 'SHIP',
  "riskReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "dataSnapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderIntelligence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."ConsigneeProfile" (
  "id" TEXT NOT NULL,
  "phoneHash" TEXT NOT NULL,
  "totalOrders" INTEGER NOT NULL DEFAULT 0,
  "deliveredOrders" INTEGER NOT NULL DEFAULT 0,
  "rtoOrders" INTEGER NOT NULL DEFAULT 0,
  "ndrOrders" INTEGER NOT NULL DEFAULT 0,
  "cancelledOrders" INTEGER NOT NULL DEFAULT 0,
  "codOrders" INTEGER NOT NULL DEFAULT 0,
  "prepaidOrders" INTEGER NOT NULL DEFAULT 0,
  "postpaidOrders" INTEGER NOT NULL DEFAULT 0,
  "successfulCodOrders" INTEGER NOT NULL DEFAULT 0,
  "failedCodOrders" INTEGER NOT NULL DEFAULT 0,
  "repeatCodFailures" INTEGER NOT NULL DEFAULT 0,
  "avgOrderValue" NUMERIC(12,2) NOT NULL DEFAULT 0,
  "maxOrderValue" NUMERIC(12,2) NOT NULL DEFAULT 0,
  "avgCodAmount" NUMERIC(12,2) NOT NULL DEFAULT 0,
  "maxCodAmount" NUMERIC(12,2) NOT NULL DEFAULT 0,
  "addressCount" INTEGER NOT NULL DEFAULT 0,
  "highRiskAddressCount" INTEGER NOT NULL DEFAULT 0,
  "pincodeCount" INTEGER NOT NULL DEFAULT 0,
  "deliverySuccessRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "rtoRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "ndrRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "codSuccessRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "prepaidRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "codRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "trustScore" INTEGER NOT NULL DEFAULT 50,
  "tier" "public"."ConsigneeTier" NOT NULL DEFAULT 'SILVER',
  "riskLevel" "public"."RiskLevel" NOT NULL DEFAULT 'MEDIUM',
  "lastOrderAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConsigneeProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShipmentDetails_orderId_key" ON "public"."ShipmentDetails"("orderId");
CREATE INDEX "ShipmentDetails_merchantId_idx" ON "public"."ShipmentDetails"("merchantId");
CREATE INDEX "ShipmentDetails_courierId_idx" ON "public"."ShipmentDetails"("courierId");
CREATE INDEX "ShipmentDetails_awb_idx" ON "public"."ShipmentDetails"("awb");
CREATE INDEX "ShipmentDetails_trackingNumber_idx" ON "public"."ShipmentDetails"("trackingNumber");
CREATE INDEX "ShipmentDetails_pincode_idx" ON "public"."ShipmentDetails"("pincode");
CREATE INDEX "ShipmentDetails_shipmentStatus_idx" ON "public"."ShipmentDetails"("shipmentStatus");
CREATE INDEX "ShipmentDetails_createdAt_idx" ON "public"."ShipmentDetails"("createdAt");

CREATE UNIQUE INDEX "OrderIntelligence_orderId_key" ON "public"."OrderIntelligence"("orderId");
CREATE INDEX "OrderIntelligence_merchantId_idx" ON "public"."OrderIntelligence"("merchantId");
CREATE INDEX "OrderIntelligence_buyerPhoneHash_idx" ON "public"."OrderIntelligence"("buyerPhoneHash");
CREATE INDEX "OrderIntelligence_addressHash_idx" ON "public"."OrderIntelligence"("addressHash");
CREATE INDEX "OrderIntelligence_pincode_idx" ON "public"."OrderIntelligence"("pincode");
CREATE INDEX "OrderIntelligence_consigneeTier_idx" ON "public"."OrderIntelligence"("consigneeTier");
CREATE INDEX "OrderIntelligence_codDecision_idx" ON "public"."OrderIntelligence"("codDecision");
CREATE INDEX "OrderIntelligence_shipmentDecision_idx" ON "public"."OrderIntelligence"("shipmentDecision");
CREATE INDEX "OrderIntelligence_overallRiskScore_idx" ON "public"."OrderIntelligence"("overallRiskScore");
CREATE INDEX "OrderIntelligence_createdAt_idx" ON "public"."OrderIntelligence"("createdAt");

CREATE UNIQUE INDEX "ConsigneeProfile_phoneHash_key" ON "public"."ConsigneeProfile"("phoneHash");
CREATE INDEX "ConsigneeProfile_phoneHash_idx" ON "public"."ConsigneeProfile"("phoneHash");
CREATE INDEX "ConsigneeProfile_tier_idx" ON "public"."ConsigneeProfile"("tier");
CREATE INDEX "ConsigneeProfile_riskLevel_idx" ON "public"."ConsigneeProfile"("riskLevel");
CREATE INDEX "ConsigneeProfile_trustScore_idx" ON "public"."ConsigneeProfile"("trustScore");
CREATE INDEX "ConsigneeProfile_lastOrderAt_idx" ON "public"."ConsigneeProfile"("lastOrderAt");

ALTER TABLE "public"."ShipmentDetails" ADD CONSTRAINT "ShipmentDetails_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."OrderIntelligence" ADD CONSTRAINT "OrderIntelligence_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
