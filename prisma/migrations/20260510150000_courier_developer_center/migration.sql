ALTER TABLE "public"."CourierWebhookConfig"
  ADD COLUMN "secretRef" TEXT,
  ADD COLUMN "maskedSecret" TEXT,
  ADD COLUMN "signingMethod" TEXT NOT NULL DEFAULT 'HMAC_SHA256';

CREATE TABLE "public"."CourierDeveloperCredential" (
  "id" TEXT NOT NULL,
  "courierId" TEXT NOT NULL,
  "environment" TEXT NOT NULL DEFAULT 'sandbox',
  "credentialType" TEXT NOT NULL,
  "maskedValue" TEXT NOT NULL,
  "secretRef" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourierDeveloperCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierApiEvent" (
  "id" TEXT NOT NULL,
  "courierId" TEXT NOT NULL,
  "courierShipmentId" TEXT,
  "eventType" TEXT NOT NULL,
  "externalEventId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'INBOUND_COURIER',
  "status" TEXT NOT NULL DEFAULT 'ACCEPTED',
  "signatureValid" BOOLEAN NOT NULL DEFAULT false,
  "error" TEXT,
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CourierApiEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourierDeveloperCredential_secretRef_key" ON "public"."CourierDeveloperCredential"("secretRef");
CREATE UNIQUE INDEX "CourierDeveloperCredential_courierId_environment_credentialType_key" ON "public"."CourierDeveloperCredential"("courierId", "environment", "credentialType");
CREATE INDEX "CourierDeveloperCredential_courierId_idx" ON "public"."CourierDeveloperCredential"("courierId");
CREATE INDEX "CourierDeveloperCredential_environment_idx" ON "public"."CourierDeveloperCredential"("environment");
CREATE INDEX "CourierDeveloperCredential_credentialType_idx" ON "public"."CourierDeveloperCredential"("credentialType");
CREATE INDEX "CourierDeveloperCredential_status_idx" ON "public"."CourierDeveloperCredential"("status");

CREATE INDEX "CourierWebhookConfig_secretRef_idx" ON "public"."CourierWebhookConfig"("secretRef");

CREATE INDEX "CourierApiEvent_courierId_idx" ON "public"."CourierApiEvent"("courierId");
CREATE INDEX "CourierApiEvent_courierShipmentId_idx" ON "public"."CourierApiEvent"("courierShipmentId");
CREATE INDEX "CourierApiEvent_eventType_idx" ON "public"."CourierApiEvent"("eventType");
CREATE INDEX "CourierApiEvent_status_idx" ON "public"."CourierApiEvent"("status");
CREATE INDEX "CourierApiEvent_createdAt_idx" ON "public"."CourierApiEvent"("createdAt");
CREATE INDEX "CourierApiEvent_externalEventId_idx" ON "public"."CourierApiEvent"("externalEventId");

ALTER TABLE "public"."CourierDeveloperCredential"
  ADD CONSTRAINT "CourierDeveloperCredential_courierId_fkey"
  FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."CourierApiEvent"
  ADD CONSTRAINT "CourierApiEvent_courierId_fkey"
  FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."CourierApiEvent"
  ADD CONSTRAINT "CourierApiEvent_courierShipmentId_fkey"
  FOREIGN KEY ("courierShipmentId") REFERENCES "public"."CourierShipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
