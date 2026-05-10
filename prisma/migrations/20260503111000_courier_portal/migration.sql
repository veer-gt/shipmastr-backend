CREATE TABLE "public"."CourierUser" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'courier_partner',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierShipment" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "orderId" TEXT,
    "awbNumber" TEXT NOT NULL,
    "fromPincode" TEXT NOT NULL,
    "toPincode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pickup_scheduled',
    "weightGrams" INTEGER,
    "paymentMode" "public"."PaymentMode" NOT NULL DEFAULT 'PREPAID',
    "codAmount" INTEGER NOT NULL DEFAULT 0,
    "lastEvent" TEXT,
    "expectedDeliveryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierShipment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierEvent" (
    "id" TEXT NOT NULL,
    "courierShipmentId" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "courierUserId" TEXT,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "location" TEXT,
    "remarks" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierNdr" (
    "id" TEXT NOT NULL,
    "courierShipmentId" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actionRequired" TEXT NOT NULL,
    "nextAttemptDate" TIMESTAMP(3),
    "remarks" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierNdr_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierRto" (
    "id" TEXT NOT NULL,
    "courierShipmentId" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "rtoStatus" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expectedReturnDate" TIMESTAMP(3),
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierRto_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierWebhookConfig" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "events" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierWebhookConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierInvoice" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "shipmentCount" INTEGER NOT NULL DEFAULT 0,
    "payableAmount" INTEGER NOT NULL DEFAULT 0,
    "deductions" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierInvoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourierUser_email_key" ON "public"."CourierUser"("email");
CREATE INDEX "CourierUser_courierId_idx" ON "public"."CourierUser"("courierId");
CREATE INDEX "CourierUser_active_idx" ON "public"."CourierUser"("active");

CREATE UNIQUE INDEX "CourierShipment_awbNumber_key" ON "public"."CourierShipment"("awbNumber");
CREATE INDEX "CourierShipment_courierId_idx" ON "public"."CourierShipment"("courierId");
CREATE INDEX "CourierShipment_courierId_status_idx" ON "public"."CourierShipment"("courierId", "status");
CREATE INDEX "CourierShipment_orderId_idx" ON "public"."CourierShipment"("orderId");

CREATE INDEX "CourierEvent_courierId_idx" ON "public"."CourierEvent"("courierId");
CREATE INDEX "CourierEvent_courierShipmentId_idx" ON "public"."CourierEvent"("courierShipmentId");
CREATE INDEX "CourierEvent_status_idx" ON "public"."CourierEvent"("status");

CREATE UNIQUE INDEX "CourierNdr_courierShipmentId_key" ON "public"."CourierNdr"("courierShipmentId");
CREATE INDEX "CourierNdr_courierId_idx" ON "public"."CourierNdr"("courierId");
CREATE INDEX "CourierNdr_status_idx" ON "public"."CourierNdr"("status");

CREATE UNIQUE INDEX "CourierRto_courierShipmentId_key" ON "public"."CourierRto"("courierShipmentId");
CREATE INDEX "CourierRto_courierId_idx" ON "public"."CourierRto"("courierId");
CREATE INDEX "CourierRto_rtoStatus_idx" ON "public"."CourierRto"("rtoStatus");

CREATE INDEX "CourierWebhookConfig_courierId_idx" ON "public"."CourierWebhookConfig"("courierId");
CREATE INDEX "CourierWebhookConfig_active_idx" ON "public"."CourierWebhookConfig"("active");

CREATE INDEX "CourierInvoice_courierId_idx" ON "public"."CourierInvoice"("courierId");
CREATE INDEX "CourierInvoice_status_idx" ON "public"."CourierInvoice"("status");

ALTER TABLE "public"."CourierUser" ADD CONSTRAINT "CourierUser_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."CourierShipment" ADD CONSTRAINT "CourierShipment_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."CourierEvent" ADD CONSTRAINT "CourierEvent_courierShipmentId_fkey" FOREIGN KEY ("courierShipmentId") REFERENCES "public"."CourierShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."CourierNdr" ADD CONSTRAINT "CourierNdr_courierShipmentId_fkey" FOREIGN KEY ("courierShipmentId") REFERENCES "public"."CourierShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."CourierRto" ADD CONSTRAINT "CourierRto_courierShipmentId_fkey" FOREIGN KEY ("courierShipmentId") REFERENCES "public"."CourierShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."CourierWebhookConfig" ADD CONSTRAINT "CourierWebhookConfig_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."CourierInvoice" ADD CONSTRAINT "CourierInvoice_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
