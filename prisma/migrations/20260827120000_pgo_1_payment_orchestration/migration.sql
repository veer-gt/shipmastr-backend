-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('MOCK', 'CASHFREE', 'PAYTM');

-- CreateEnum
CREATE TYPE "ProviderEnvironment" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "OutcomeStatus" AS ENUM ('PENDING', 'UNKNOWN', 'SUCCEEDED', 'FAILED_TERMINAL', 'NOT_FOUND_TERMINAL');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('NOT_REQUIRED', 'REQUIRED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ObligationStatus" AS ENUM ('OPEN', 'SATISFIED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ObligationPurpose" AS ENUM ('FULL_ONLINE', 'COD_ADVANCE', 'COD_DELIVERY_BALANCE');

-- CreateEnum
CREATE TYPE "CollectionRail" AS ENUM ('ONLINE', 'COD');

-- CreateEnum
CREATE TYPE "ProviderObservationSource" AS ENUM ('WEBHOOK', 'STATUS_QUERY', 'PROVIDER_RECORD', 'MOCK');

-- CreateEnum
CREATE TYPE "SignatureVerification" AS ENUM ('VERIFIED', 'FAILED', 'NOT_APPLICABLE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "EvidenceAuthority" AS ENUM ('ELIGIBLE', 'ACTIVATION_GATED', 'INELIGIBLE');

-- CreateEnum
CREATE TYPE "ReviewCompletedByType" AS ENUM ('SYSTEM', 'REVIEWER');

-- CreateEnum
CREATE TYPE "RefundDueReason" AS ENUM ('LATE_SUCCESS_AFTER_CLOSURE', 'SURPLUS_DOUBLE_SUCCESS');

-- CreateEnum
CREATE TYPE "RefundDueCaseStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'MERCHANT_ACTION_PENDING', 'VERIFICATION_PENDING', 'VERIFIED_CLOSED', 'ESCALATED_UNRESOLVED');

-- CreateTable
CREATE TABLE "PaymentObligation" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "collectionRail" "CollectionRail" NOT NULL,
    "purpose" "ObligationPurpose" NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "ObligationStatus" NOT NULL,
    "satisfiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "environment" "ProviderEnvironment" NOT NULL,
    "credentialBindingId" TEXT NOT NULL,
    "credentialVersionId" TEXT NOT NULL,
    "requestIdempotencyKey" TEXT NOT NULL,
    "providerOrderRef" TEXT,
    "outcomeStatus" "OutcomeStatus" NOT NULL,
    "reviewStatus" "ReviewStatus" NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "lastOutcomeChangedAt" TIMESTAMP(3) NOT NULL,
    "lastObservationAt" TIMESTAMP(3),
    "adapterVersion" TEXT NOT NULL,
    "mappingVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderObservation" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "environment" "ProviderEnvironment" NOT NULL,
    "credentialBindingId" TEXT NOT NULL,
    "credentialVersionId" TEXT NOT NULL,
    "source" "ProviderObservationSource" NOT NULL,
    "providerEventId" TEXT,
    "providerOrderRef" TEXT,
    "providerTransactionRef" TEXT,
    "nativeStatus" TEXT NOT NULL,
    "nativeReasonCode" TEXT,
    "nativeAmountText" TEXT,
    "nativeCurrency" TEXT,
    "amountPaise" BIGINT,
    "rawBodyHash" TEXT NOT NULL,
    "hashAlgorithm" TEXT NOT NULL,
    "signatureVerification" "SignatureVerification" NOT NULL,
    "bindingVerification" TEXT NOT NULL,
    "evidenceAuthority" "EvidenceAuthority" NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "mappingVersion" TEXT NOT NULL,
    "providerOccurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "reductionDisposition" TEXT NOT NULL,
    "observationDedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderObservationDelivery" (
    "id" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "source" "ProviderObservationSource" NOT NULL,
    "providerEventId" TEXT,
    "rawBodyHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "deliveryMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderObservationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderObservationInterpretation" (
    "id" TEXT NOT NULL,
    "originalObservationId" TEXT NOT NULL,
    "derivedObservationId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "derivedAdapterVersion" TEXT NOT NULL,
    "derivedMappingVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderObservationInterpretation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentOutcomeTransition" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "priorOutcomeStatus" "OutcomeStatus",
    "nextOutcomeStatus" "OutcomeStatus" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "triggeringObservationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentOutcomeTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationReviewHistory" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "priorReviewStatus" "ReviewStatus" NOT NULL,
    "nextReviewStatus" "ReviewStatus" NOT NULL,
    "completedByType" "ReviewCompletedByType",
    "actorId" TEXT,
    "reasonCode" TEXT NOT NULL,
    "triggeringObservationId" TEXT,
    "evidenceReferenceIds" JSONB,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationReviewHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttentionSignal" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "signalCode" TEXT NOT NULL,
    "observationId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAttentionSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentNormalizedFactOutbox" (
    "id" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "triggeringObservationId" TEXT NOT NULL,
    "factType" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerReferenceId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "reducerVersion" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "mappingVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentNormalizedFactOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundDueCase" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerTransactionRef" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" "RefundDueReason" NOT NULL,
    "status" "RefundDueCaseStatus" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "verifiedClosedAt" TIMESTAMP(3),
    "verificationObservationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundDueCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentObligation_merchantId_idx" ON "PaymentObligation"("merchantId");

-- CreateIndex
CREATE INDEX "PaymentObligation_checkoutId_idx" ON "PaymentObligation"("checkoutId");

-- CreateIndex
CREATE INDEX "PaymentObligation_status_idx" ON "PaymentObligation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_request_idempotency" ON "PaymentAttempt"("merchantId", "requestIdempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentAttempt_obligationId_idx" ON "PaymentAttempt"("obligationId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_merchantId_idx" ON "PaymentAttempt"("merchantId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_provider_environment_idx" ON "PaymentAttempt"("provider", "environment");

-- CreateIndex
CREATE INDEX "PaymentAttempt_reviewStatus_idx" ON "PaymentAttempt"("reviewStatus");

-- CreateIndex
CREATE INDEX "PaymentAttempt_outcomeStatus_idx" ON "PaymentAttempt"("outcomeStatus");

-- CreateIndex
CREATE UNIQUE INDEX "provider_observation_dedupe" ON "ProviderObservation"("observationDedupeKey");

-- CreateIndex
CREATE INDEX "ProviderObservation_attemptId_idx" ON "ProviderObservation"("attemptId");

-- CreateIndex
CREATE INDEX "ProviderObservation_obligationId_idx" ON "ProviderObservation"("obligationId");

-- CreateIndex
CREATE INDEX "ProviderObservation_merchantId_idx" ON "ProviderObservation"("merchantId");

-- CreateIndex
CREATE INDEX "ProviderObservation_provider_environment_idx" ON "ProviderObservation"("provider", "environment");

-- CreateIndex
CREATE INDEX "ProviderObservation_providerTransactionRef_idx" ON "ProviderObservation"("providerTransactionRef");

-- CreateIndex
CREATE INDEX "ProviderObservation_providerEventId_idx" ON "ProviderObservation"("providerEventId");

-- CreateIndex
CREATE INDEX "ProviderObservationDelivery_observationId_idx" ON "ProviderObservationDelivery"("observationId");

-- CreateIndex
CREATE INDEX "ProviderObservationDelivery_merchantId_idx" ON "ProviderObservationDelivery"("merchantId");

-- CreateIndex
CREATE INDEX "ProviderObservationDelivery_attemptId_idx" ON "ProviderObservationDelivery"("attemptId");

-- CreateIndex
CREATE INDEX "ProviderObservationDelivery_obligationId_idx" ON "ProviderObservationDelivery"("obligationId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_observation_interpretation_dedupe" ON "ProviderObservationInterpretation"("originalObservationId", "derivedAdapterVersion", "derivedMappingVersion");

-- CreateIndex
CREATE INDEX "ProviderObservationInterpretation_derivedObservationId_idx" ON "ProviderObservationInterpretation"("derivedObservationId");

-- CreateIndex
CREATE INDEX "ProviderObservationInterpretation_merchantId_idx" ON "ProviderObservationInterpretation"("merchantId");

-- CreateIndex
CREATE INDEX "ProviderObservationInterpretation_attemptId_idx" ON "ProviderObservationInterpretation"("attemptId");

-- CreateIndex
CREATE INDEX "ProviderObservationInterpretation_obligationId_idx" ON "ProviderObservationInterpretation"("obligationId");

-- CreateIndex
CREATE INDEX "PaymentOutcomeTransition_attemptId_createdAt_idx" ON "PaymentOutcomeTransition"("attemptId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentOutcomeTransition_obligationId_createdAt_idx" ON "PaymentOutcomeTransition"("obligationId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentOutcomeTransition_merchantId_createdAt_idx" ON "PaymentOutcomeTransition"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "ReconciliationReviewHistory_attemptId_createdAt_idx" ON "ReconciliationReviewHistory"("attemptId", "createdAt");

-- CreateIndex
CREATE INDEX "ReconciliationReviewHistory_obligationId_createdAt_idx" ON "ReconciliationReviewHistory"("obligationId", "createdAt");

-- CreateIndex
CREATE INDEX "ReconciliationReviewHistory_merchantId_createdAt_idx" ON "ReconciliationReviewHistory"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentAttentionSignal_attemptId_createdAt_idx" ON "PaymentAttentionSignal"("attemptId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentAttentionSignal_obligationId_createdAt_idx" ON "PaymentAttentionSignal"("obligationId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentAttentionSignal_merchantId_createdAt_idx" ON "PaymentAttentionSignal"("merchantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_fact_dedupe" ON "PaymentNormalizedFactOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "PaymentNormalizedFactOutbox_merchantId_createdAt_idx" ON "PaymentNormalizedFactOutbox"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentNormalizedFactOutbox_obligationId_createdAt_idx" ON "PaymentNormalizedFactOutbox"("obligationId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentNormalizedFactOutbox_attemptId_createdAt_idx" ON "PaymentNormalizedFactOutbox"("attemptId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "refund_due_case_dedupe" ON "RefundDueCase"("dedupeKey");

-- CreateIndex
CREATE INDEX "RefundDueCase_merchantId_detectedAt_idx" ON "RefundDueCase"("merchantId", "detectedAt");

-- CreateIndex
CREATE INDEX "RefundDueCase_obligationId_detectedAt_idx" ON "RefundDueCase"("obligationId", "detectedAt");

-- CreateIndex
CREATE INDEX "RefundDueCase_attemptId_detectedAt_idx" ON "RefundDueCase"("attemptId", "detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_one_unresolved_per_obligation"
ON "PaymentAttempt" ("obligationId")
WHERE "resolvedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "PaymentObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderObservation" ADD CONSTRAINT "ProviderObservation_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderObservation" ADD CONSTRAINT "ProviderObservation_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "PaymentObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderObservationDelivery" ADD CONSTRAINT "ProviderObservationDelivery_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "ProviderObservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderObservationInterpretation" ADD CONSTRAINT "ProviderObservationInterpretation_originalObservationId_fkey" FOREIGN KEY ("originalObservationId") REFERENCES "ProviderObservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderObservationInterpretation" ADD CONSTRAINT "ProviderObservationInterpretation_derivedObservationId_fkey" FOREIGN KEY ("derivedObservationId") REFERENCES "ProviderObservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOutcomeTransition" ADD CONSTRAINT "PaymentOutcomeTransition_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOutcomeTransition" ADD CONSTRAINT "PaymentOutcomeTransition_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "PaymentObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOutcomeTransition" ADD CONSTRAINT "PaymentOutcomeTransition_triggeringObservationId_fkey" FOREIGN KEY ("triggeringObservationId") REFERENCES "ProviderObservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationReviewHistory" ADD CONSTRAINT "ReconciliationReviewHistory_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationReviewHistory" ADD CONSTRAINT "ReconciliationReviewHistory_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "PaymentObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationReviewHistory" ADD CONSTRAINT "ReconciliationReviewHistory_triggeringObservationId_fkey" FOREIGN KEY ("triggeringObservationId") REFERENCES "ProviderObservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttentionSignal" ADD CONSTRAINT "PaymentAttentionSignal_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttentionSignal" ADD CONSTRAINT "PaymentAttentionSignal_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "PaymentObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttentionSignal" ADD CONSTRAINT "PaymentAttentionSignal_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "ProviderObservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentNormalizedFactOutbox" ADD CONSTRAINT "PaymentNormalizedFactOutbox_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "PaymentObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentNormalizedFactOutbox" ADD CONSTRAINT "PaymentNormalizedFactOutbox_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentNormalizedFactOutbox" ADD CONSTRAINT "PaymentNormalizedFactOutbox_triggeringObservationId_fkey" FOREIGN KEY ("triggeringObservationId") REFERENCES "ProviderObservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundDueCase" ADD CONSTRAINT "RefundDueCase_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "PaymentObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundDueCase" ADD CONSTRAINT "RefundDueCase_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundDueCase" ADD CONSTRAINT "RefundDueCase_verificationObservationId_fkey" FOREIGN KEY ("verificationObservationId") REFERENCES "ProviderObservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "payment_attempt_outcome_resolution_ck"
CHECK (("outcomeStatus" IN ('SUCCEEDED','FAILED_TERMINAL','NOT_FOUND_TERMINAL')) = ("resolvedAt" IS NOT NULL));

ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "payment_attempt_review_completed_ck"
CHECK ("reviewStatus" <> 'COMPLETED' OR "resolvedAt" IS NOT NULL);

ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "payment_attempt_resolved_review_ck"
CHECK ("resolvedAt" IS NULL OR "reviewStatus" NOT IN ('REQUIRED','IN_PROGRESS'));

ALTER TABLE "PaymentObligation" ADD CONSTRAINT "payment_obligation_money_ck"
CHECK ("currency" = 'INR' AND "amountPaise" > 0);

ALTER TABLE "PaymentObligation" ADD CONSTRAINT "payment_obligation_rail_purpose_ck"
CHECK (
  ("collectionRail" = 'ONLINE' AND "purpose" IN ('FULL_ONLINE','COD_ADVANCE'))
  OR ("collectionRail" = 'COD' AND "purpose" = 'COD_DELIVERY_BALANCE')
);

ALTER TABLE "PaymentNormalizedFactOutbox" ADD CONSTRAINT "payment_fact_money_ck"
CHECK ("currency" = 'INR' AND "amountPaise" > 0);

ALTER TABLE "RefundDueCase" ADD CONSTRAINT "refund_due_money_ck"
CHECK ("currency" = 'INR' AND "amountPaise" > 0);
