CREATE TYPE "public"."CourierPartnerOnboardingStatus" AS ENUM (
    'DRAFT',
    'SUBMITTED',
    'IN_REVIEW',
    'SANDBOX_TESTING',
    'PROD_READY',
    'LIVE',
    'BLOCKED',
    'REOPENED'
);

ALTER TABLE "public"."PasswordResetToken" ADD COLUMN "courierUserId" TEXT;
ALTER TABLE "public"."PasswordResetToken" ALTER COLUMN "userId" DROP NOT NULL;

CREATE TABLE "public"."CourierPartnerOnboarding" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "status" "public"."CourierPartnerOnboardingStatus" NOT NULL DEFAULT 'DRAFT',
    "companyLegal" JSONB NOT NULL DEFAULT '{}',
    "commercial" JSONB NOT NULL DEFAULT '{}',
    "serviceability" JSONB NOT NULL DEFAULT '{}',
    "codRemittance" JSONB NOT NULL DEFAULT '{}',
    "api" JSONB NOT NULL DEFAULT '{}',
    "webhookSecurity" JSONB NOT NULL DEFAULT '{}',
    "escalation" JSONB NOT NULL DEFAULT '{}',
    "changeRequest" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierPartnerOnboarding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierPartnerCredential" (
    "id" TEXT NOT NULL,
    "onboardingId" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "maskedValue" TEXT NOT NULL,
    "secretRef" TEXT NOT NULL,
    "secretStatus" TEXT NOT NULL DEFAULT 'STORED',
    "providedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierPartnerCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierPartnerSecret" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "secretRef" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
    "keyVersion" TEXT NOT NULL DEFAULT 'app-secret-pepper-v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierPartnerSecret_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierPartnerOnboardingAudit" (
    "id" TEXT NOT NULL,
    "onboardingId" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierPartnerOnboardingAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourierPartnerOnboarding_courierId_key" ON "public"."CourierPartnerOnboarding"("courierId");
CREATE INDEX "CourierPartnerOnboarding_status_idx" ON "public"."CourierPartnerOnboarding"("status");
CREATE INDEX "CourierPartnerOnboarding_updatedAt_idx" ON "public"."CourierPartnerOnboarding"("updatedAt");

CREATE UNIQUE INDEX "CourierPartnerCredential_onboardingId_environment_fieldKey_key" ON "public"."CourierPartnerCredential"("onboardingId", "environment", "fieldKey");
CREATE INDEX "CourierPartnerCredential_courierId_idx" ON "public"."CourierPartnerCredential"("courierId");
CREATE INDEX "CourierPartnerCredential_secretRef_idx" ON "public"."CourierPartnerCredential"("secretRef");

CREATE UNIQUE INDEX "CourierPartnerSecret_secretRef_key" ON "public"."CourierPartnerSecret"("secretRef");
CREATE INDEX "CourierPartnerSecret_courierId_idx" ON "public"."CourierPartnerSecret"("courierId");

CREATE INDEX "CourierPartnerOnboardingAudit_onboardingId_idx" ON "public"."CourierPartnerOnboardingAudit"("onboardingId");
CREATE INDEX "CourierPartnerOnboardingAudit_courierId_idx" ON "public"."CourierPartnerOnboardingAudit"("courierId");
CREATE INDEX "CourierPartnerOnboardingAudit_actorType_idx" ON "public"."CourierPartnerOnboardingAudit"("actorType");
CREATE INDEX "CourierPartnerOnboardingAudit_action_idx" ON "public"."CourierPartnerOnboardingAudit"("action");
CREATE INDEX "CourierPartnerOnboardingAudit_createdAt_idx" ON "public"."CourierPartnerOnboardingAudit"("createdAt");

CREATE INDEX "PasswordResetToken_courierUserId_idx" ON "public"."PasswordResetToken"("courierUserId");

ALTER TABLE "public"."PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_courierUserId_fkey" FOREIGN KEY ("courierUserId") REFERENCES "public"."CourierUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."CourierPartnerOnboarding" ADD CONSTRAINT "CourierPartnerOnboarding_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."CourierPartnerCredential" ADD CONSTRAINT "CourierPartnerCredential_onboardingId_fkey" FOREIGN KEY ("onboardingId") REFERENCES "public"."CourierPartnerOnboarding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."CourierPartnerSecret" ADD CONSTRAINT "CourierPartnerSecret_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."CourierPartnerOnboardingAudit" ADD CONSTRAINT "CourierPartnerOnboardingAudit_onboardingId_fkey" FOREIGN KEY ("onboardingId") REFERENCES "public"."CourierPartnerOnboarding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

