CREATE TYPE "public"."CourierSandboxVerificationStatus" AS ENUM (
    'PENDING',
    'IN_PROGRESS',
    'PASSED',
    'FAILED',
    'BLOCKED'
);

CREATE TABLE "public"."CourierSandboxVerificationChecklistItem" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "public"."CourierSandboxVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "owner" TEXT,
    "notes" TEXT,
    "evidenceUrl" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierSandboxVerificationChecklistItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourierSandboxVerificationChecklistItem_courierId_itemKey_key" ON "public"."CourierSandboxVerificationChecklistItem"("courierId", "itemKey");
CREATE INDEX "CourierSandboxVerificationChecklistItem_courierId_idx" ON "public"."CourierSandboxVerificationChecklistItem"("courierId");
CREATE INDEX "CourierSandboxVerificationChecklistItem_status_idx" ON "public"."CourierSandboxVerificationChecklistItem"("status");
CREATE INDEX "CourierSandboxVerificationChecklistItem_verifiedBy_idx" ON "public"."CourierSandboxVerificationChecklistItem"("verifiedBy");

ALTER TABLE "public"."CourierSandboxVerificationChecklistItem" ADD CONSTRAINT "CourierSandboxVerificationChecklistItem_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
