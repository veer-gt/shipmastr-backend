CREATE TYPE "CourierPartnerApplicationStatus" AS ENUM ('PENDING_REVIEW', 'IN_REVIEW', 'CONVERTED', 'REJECTED');

CREATE TABLE "CourierPartnerApplication" (
    "id" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "website" TEXT,
    "gstin" TEXT NOT NULL,
    "registeredState" TEXT NOT NULL,
    "registeredCity" TEXT NOT NULL,
    "operationalStates" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "serviceablePincodesEstimate" TEXT NOT NULL,
    "codSupported" BOOLEAN NOT NULL,
    "apiAvailable" BOOLEAN NOT NULL,
    "notes" TEXT,
    "status" "CourierPartnerApplicationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "convertedCourierId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierPartnerApplication_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CourierPartnerApplication_status_idx" ON "CourierPartnerApplication"("status");
CREATE INDEX "CourierPartnerApplication_email_idx" ON "CourierPartnerApplication"("email");
CREATE INDEX "CourierPartnerApplication_gstin_idx" ON "CourierPartnerApplication"("gstin");
CREATE INDEX "CourierPartnerApplication_createdAt_idx" ON "CourierPartnerApplication"("createdAt");
CREATE INDEX "CourierPartnerApplication_convertedCourierId_idx" ON "CourierPartnerApplication"("convertedCourierId");
