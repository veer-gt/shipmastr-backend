CREATE TYPE "public"."ActualOutcome" AS ENUM ('PENDING', 'DELIVERED', 'NDR', 'RTO', 'CANCELLED', 'RETURNED', 'LOST');

CREATE TABLE "public"."PredictionOutcome" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "predictedConsigneeTier" "public"."ConsigneeTier" NOT NULL,
  "predictedCodDecision" "public"."CodDecision" NOT NULL,
  "predictedShipmentDecision" "public"."ShipmentDecision" NOT NULL,
  "predictedRtoRiskScore" INTEGER,
  "predictedCourierId" TEXT,
  "actualOutcome" "public"."ActualOutcome" NOT NULL DEFAULT 'PENDING',
  "predictionCorrect" BOOLEAN,
  "falsePositive" BOOLEAN,
  "falseNegative" BOOLEAN,
  "reasonMismatch" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "evaluatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PredictionOutcome_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."OrderDataSignals" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "skuId" TEXT,
  "productCategory" TEXT,
  "itemCount" INTEGER,
  "productTitleNormalized" TEXT,
  "salesChannel" TEXT,
  "storePlatform" TEXT,
  "utmSource" TEXT,
  "utmMedium" TEXT,
  "utmCampaign" TEXT,
  "campaignId" TEXT,
  "couponCode" TEXT,
  "discountAmount" NUMERIC(12,2),
  "discountPercent" DOUBLE PRECISION,
  "otpVerified" BOOLEAN NOT NULL DEFAULT false,
  "whatsappConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "callConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "failedOtpAttempts" INTEGER NOT NULL DEFAULT 0,
  "orderHour" INTEGER NOT NULL,
  "orderDayOfWeek" INTEGER NOT NULL,
  "isLateNightOrder" BOOLEAN NOT NULL DEFAULT false,
  "isWeekendOrder" BOOLEAN NOT NULL DEFAULT false,
  "sellerProcessingTimeMinutes" INTEGER,
  "ndrActionDelayMinutes" INTEGER,
  "shippingChargeToSeller" NUMERIC(12,2),
  "courierCostToShipmastr" NUMERIC(12,2),
  "codFeeCharged" NUMERIC(12,2),
  "codFeeCost" NUMERIC(12,2),
  "rtoCost" NUMERIC(12,2),
  "netMargin" NUMERIC(12,2),
  "marginAfterRto" NUMERIC(12,2),
  "promisedPickupDate" TIMESTAMP(3),
  "actualPickupDate" TIMESTAMP(3),
  "promisedDeliveryDate" TIMESTAMP(3),
  "actualDeliveryDate" TIMESTAMP(3),
  "promiseBreached" BOOLEAN,
  "declaredWeight" NUMERIC(12,2),
  "chargedWeight" NUMERIC(12,2),
  "courierMeasuredWeight" NUMERIC(12,2),
  "weightDisputeRaised" BOOLEAN NOT NULL DEFAULT false,
  "manualEditCount" INTEGER NOT NULL DEFAULT 0,
  "addressEditedAfterCreation" BOOLEAN NOT NULL DEFAULT false,
  "paymentModeChangedAfterCreation" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderDataSignals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PredictionOutcome_orderId_key" ON "public"."PredictionOutcome"("orderId");
CREATE INDEX "PredictionOutcome_orderId_idx" ON "public"."PredictionOutcome"("orderId");
CREATE INDEX "PredictionOutcome_merchantId_idx" ON "public"."PredictionOutcome"("merchantId");
CREATE INDEX "PredictionOutcome_actualOutcome_idx" ON "public"."PredictionOutcome"("actualOutcome");
CREATE INDEX "PredictionOutcome_predictionCorrect_idx" ON "public"."PredictionOutcome"("predictionCorrect");
CREATE INDEX "PredictionOutcome_createdAt_idx" ON "public"."PredictionOutcome"("createdAt");

CREATE UNIQUE INDEX "OrderDataSignals_orderId_key" ON "public"."OrderDataSignals"("orderId");
CREATE INDEX "OrderDataSignals_orderId_idx" ON "public"."OrderDataSignals"("orderId");
CREATE INDEX "OrderDataSignals_merchantId_idx" ON "public"."OrderDataSignals"("merchantId");
CREATE INDEX "OrderDataSignals_skuId_idx" ON "public"."OrderDataSignals"("skuId");
CREATE INDEX "OrderDataSignals_campaignId_idx" ON "public"."OrderDataSignals"("campaignId");
CREATE INDEX "OrderDataSignals_salesChannel_idx" ON "public"."OrderDataSignals"("salesChannel");
CREATE INDEX "OrderDataSignals_productCategory_idx" ON "public"."OrderDataSignals"("productCategory");
CREATE INDEX "OrderDataSignals_createdAt_idx" ON "public"."OrderDataSignals"("createdAt");

CREATE INDEX "ShipmentDetails_orderId_idx" ON "public"."ShipmentDetails"("orderId");
CREATE INDEX "OrderIntelligence_orderId_idx" ON "public"."OrderIntelligence"("orderId");

ALTER TABLE "public"."PredictionOutcome" ADD CONSTRAINT "PredictionOutcome_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."OrderDataSignals" ADD CONSTRAINT "OrderDataSignals_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
