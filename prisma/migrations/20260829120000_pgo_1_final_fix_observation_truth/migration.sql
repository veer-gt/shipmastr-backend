-- PGO-1 was unreleased when this correction was authored. Refuse to invent
-- canonical mapping or API-version truth for any pre-existing observation.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ProviderObservation" LIMIT 1) THEN
    RAISE EXCEPTION 'PGO-1 observation truth migration requires an empty ProviderObservation table';
  END IF;
END $$;

CREATE TYPE "ObservationMappedOutcome" AS ENUM (
  'PENDING',
  'UNKNOWN',
  'SUCCEEDED',
  'FAILED_TERMINAL',
  'NOT_FOUND_TERMINAL',
  'UNMAPPED'
);

CREATE TYPE "ObservationHashAlgorithm" AS ENUM ('SHA-256');
CREATE TYPE "BindingVerification" AS ENUM ('VERIFIED', 'FAILED');

ALTER TABLE "ProviderObservation"
  ALTER COLUMN "hashAlgorithm" TYPE "ObservationHashAlgorithm"
    USING ("hashAlgorithm"::"ObservationHashAlgorithm"),
  ALTER COLUMN "bindingVerification" TYPE "BindingVerification"
    USING ("bindingVerification"::"BindingVerification"),
  ALTER COLUMN "providerOrderRef" SET NOT NULL,
  ADD COLUMN "mappedOutcome" "ObservationMappedOutcome" NOT NULL,
  ADD COLUMN "providerApiVersion" TEXT NOT NULL;

ALTER TABLE "ProviderObservation"
  ADD CONSTRAINT "ProviderObservation_providerOrderRef_nonempty"
  CHECK (length(btrim("providerOrderRef")) > 0),
  ADD CONSTRAINT "ProviderObservation_providerApiVersion_nonempty"
  CHECK (length(btrim("providerApiVersion")) > 0);

CREATE UNIQUE INDEX "provider_observation_scoped_event_body"
  ON "ProviderObservation"(
    "merchantId", "obligationId", "attemptId", "provider", "environment",
    "providerEventId", "rawBodyHash"
  );

ALTER TABLE "ProviderObservationInterpretation"
  DROP CONSTRAINT "ProviderObservationInterpretation_derivedObservationId_fkey";

DROP INDEX "ProviderObservationInterpretation_derivedObservationId_idx";

ALTER TABLE "ProviderObservationInterpretation"
  DROP COLUMN "derivedObservationId",
  ADD COLUMN "originalMappingVersion" TEXT NOT NULL,
  ADD COLUMN "derivedOutcome" "ObservationMappedOutcome" NOT NULL,
  ADD COLUMN "derivedAt" TIMESTAMP(3) NOT NULL;

ALTER TABLE "ProviderObservationInterpretation"
  ADD CONSTRAINT "ProviderObservationInterpretation_versions_nonempty"
  CHECK (
    length(btrim("originalMappingVersion")) > 0 AND
    length(btrim("derivedAdapterVersion")) > 0 AND
    length(btrim("derivedMappingVersion")) > 0
  );

CREATE TABLE "ProviderObservationRejection" (
  "id" TEXT NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "environment" "ProviderEnvironment" NOT NULL,
  "source" "ProviderObservationSource" NOT NULL,
  "reason" TEXT NOT NULL,
  "merchantId" TEXT,
  "obligationId" TEXT,
  "attemptId" TEXT,
  "credentialBindingId" TEXT,
  "rawBodyHash" TEXT NOT NULL,
  "hashAlgorithm" "ObservationHashAlgorithm" NOT NULL,
  "signatureVerification" "SignatureVerification" NOT NULL,
  "bindingVerification" "BindingVerification",
  "adapterVersion" TEXT NOT NULL,
  "mappingVersion" TEXT NOT NULL,
  "providerApiVersion" TEXT NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL,
  "securityAlertCode" TEXT NOT NULL,
  "securityAlertStatus" TEXT NOT NULL,
  "alertDedupeKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderObservationRejection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderObservationRejection_alert_status"
    CHECK ("securityAlertStatus" IN ('PENDING', 'DELIVERED')),
  CONSTRAINT "ProviderObservationRejection_versions_nonempty"
    CHECK (
      length(btrim("adapterVersion")) > 0 AND
      length(btrim("mappingVersion")) > 0 AND
      length(btrim("providerApiVersion")) > 0
    )
);

CREATE UNIQUE INDEX "provider_security_alert_dedupe"
  ON "ProviderObservationRejection"("alertDedupeKey");
CREATE INDEX "ProviderObservationRejection_merchantId_detectedAt_idx"
  ON "ProviderObservationRejection"("merchantId", "detectedAt");
CREATE INDEX "ProviderObservationRejection_attemptId_detectedAt_idx"
  ON "ProviderObservationRejection"("attemptId", "detectedAt");
CREATE INDEX "ProviderObservationRejection_securityAlertStatus_detectedAt_idx"
  ON "ProviderObservationRejection"("securityAlertStatus", "detectedAt");

CREATE TABLE "ProviderPolicyDecisionAudit" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "obligationId" TEXT,
  "attemptId" TEXT,
  "provider" "PaymentProvider" NOT NULL,
  "environment" "ProviderEnvironment" NOT NULL,
  "operation" TEXT NOT NULL,
  "policyVersion" TEXT,
  "policyApproved" BOOLEAN NOT NULL,
  "policyMerchantId" TEXT,
  "policyProvider" "PaymentProvider",
  "policyEnvironment" "ProviderEnvironment",
  "policyOperation" TEXT,
  "maxAmountPaise" BIGINT,
  "approvedAt" TIMESTAMP(3),
  "effectiveFrom" TIMESTAMP(3),
  "effectiveUntil" TIMESTAMP(3),
  "evaluatedAt" TIMESTAMP(3) NOT NULL,
  "decision" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "timing" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderPolicyDecisionAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderPolicyDecisionAudit_operation"
    CHECK ("operation" IN ('CREATE_ATTEMPT', 'STATUS_QUERY')),
  CONSTRAINT "ProviderPolicyDecisionAudit_policy_operation"
    CHECK ("policyOperation" IS NULL OR "policyOperation" IN ('CREATE_ATTEMPT', 'STATUS_QUERY')),
  CONSTRAINT "ProviderPolicyDecisionAudit_decision"
    CHECK ("decision" IN ('ENABLED', 'DISABLED', 'NO_EXECUTION'))
);

CREATE INDEX "ProviderPolicyDecisionAudit_merchantId_evaluatedAt_idx"
  ON "ProviderPolicyDecisionAudit"("merchantId", "evaluatedAt");
CREATE INDEX "ProviderPolicyDecisionAudit_attemptId_evaluatedAt_idx"
  ON "ProviderPolicyDecisionAudit"("attemptId", "evaluatedAt");
CREATE INDEX "ProviderPolicyDecisionAudit_provider_environment_operation_evaluatedAt_idx"
  ON "ProviderPolicyDecisionAudit"("provider", "environment", "operation", "evaluatedAt");
CREATE INDEX "ProviderPolicyDecisionAudit_decision_evaluatedAt_idx"
  ON "ProviderPolicyDecisionAudit"("decision", "evaluatedAt");
