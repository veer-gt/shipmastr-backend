CREATE TABLE "public"."CourierPartner" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "apiMode" TEXT NOT NULL DEFAULT 'manual',
    "supportsCOD" BOOLEAN NOT NULL DEFAULT true,
    "supportsPrepaid" BOOLEAN NOT NULL DEFAULT true,
    "supportsPickup" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "trackingUrlTemplate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierPartner_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."RateCard" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "minWeight" INTEGER NOT NULL,
    "maxWeight" INTEGER NOT NULL,
    "baseRate" INTEGER NOT NULL,
    "additionalRate" INTEGER NOT NULL DEFAULT 0,
    "codFee" INTEGER NOT NULL DEFAULT 0,
    "fuelSurcharge" INTEGER NOT NULL DEFAULT 0,
    "rtoCharge" INTEGER NOT NULL DEFAULT 0,
    "etaDays" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateCard_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourierPartner_code_key" ON "public"."CourierPartner"("code");
CREATE INDEX "CourierPartner_active_idx" ON "public"."CourierPartner"("active");
CREATE INDEX "CourierPartner_priority_idx" ON "public"."CourierPartner"("priority");
CREATE INDEX "RateCard_courierId_idx" ON "public"."RateCard"("courierId");
CREATE INDEX "RateCard_zone_idx" ON "public"."RateCard"("zone");
CREATE INDEX "RateCard_minWeight_maxWeight_idx" ON "public"."RateCard"("minWeight", "maxWeight");

ALTER TABLE "public"."RateCard" ADD CONSTRAINT "RateCard_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
