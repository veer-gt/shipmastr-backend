-- CreateEnum
CREATE TYPE "CourierAuditIntakeSourceProvider" AS ENUM ('GMAIL');

-- CreateEnum
CREATE TYPE "CourierAuditExtractionMode" AS ENUM ('DETERMINISTIC', 'AI_ASSISTED');

-- CreateTable
CREATE TABLE "CourierAuditIntake" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceProvider" "CourierAuditIntakeSourceProvider" NOT NULL,
    "sourceAccountId" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "providerThreadId" TEXT,
    "sourceReceivedAt" TIMESTAMP(3) NOT NULL,
    "senderName" TEXT,
    "senderEmail" TEXT,
    "subject" TEXT,
    "bodySha256" TEXT NOT NULL,
    "bodySnippet" TEXT,
    "sourceFingerprintSha256" TEXT NOT NULL,
    "attachmentManifest" JSONB NOT NULL,

    CONSTRAINT "CourierAuditIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourierAuditExtractionRevision" (
    "id" TEXT NOT NULL,
    "intakeId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "parserName" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "mode" "CourierAuditExtractionMode" NOT NULL,
    "modelProvider" TEXT,
    "modelName" TEXT,
    "promptVersion" TEXT,
    "extractedAt" TIMESTAMP(3) NOT NULL,
    "extractionResult" JSONB NOT NULL,
    "normalizedProjection" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierAuditExtractionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourierAuditIntake_createdAt_id_idx" ON "CourierAuditIntake"("createdAt", "id");

-- CreateIndex
CREATE INDEX "CourierAuditIntake_sourceReceivedAt_id_idx" ON "CourierAuditIntake"("sourceReceivedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CourierAuditIntake_sourceProvider_sourceAccountId_providerM_key" ON "CourierAuditIntake"("sourceProvider", "sourceAccountId", "providerMessageId");

-- CreateIndex
CREATE INDEX "CourierAuditExtractionRevision_intakeId_createdAt_idx" ON "CourierAuditExtractionRevision"("intakeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CourierAuditExtractionRevision_intakeId_revision_key" ON "CourierAuditExtractionRevision"("intakeId", "revision");

-- AddForeignKey
ALTER TABLE "CourierAuditExtractionRevision" ADD CONSTRAINT "CourierAuditExtractionRevision_intakeId_fkey" FOREIGN KEY ("intakeId") REFERENCES "CourierAuditIntake"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
