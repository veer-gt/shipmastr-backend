import { createHash } from 'node:crypto';
import {
  Prisma,
  PrismaClient,
  type CollectionRail,
  type PaymentAttempt,
  type PaymentObligation,
  type ProviderObservation,
} from '@prisma/client';
import { reduceEvidence } from './reducer.js';
import { persistReduction } from './reductionPersistence.js';
import type {
  CanonicalObservation,
  IngestionResult,
  ObservationCandidate,
  OutcomeStatus,
  ReduceEvidenceInput,
  ReductionPersistenceContext,
  ReviewStatus,
  ShadowMutationBoundary,
} from './types.js';
import type {
  SlaEscalationRequest,
  SlaEscalationResult,
  CredentialDenialPersistenceRequest,
} from './reconciliationWorker.js';
import type { ProviderSecurityRejectionEvidence } from './adapters/providerAdapter.js';

type Tx = Parameters<PrismaClient['$transaction']>[0] extends (tx: infer T) => unknown ? T : never;

type ObservationAppendResult =
  | {
      kind: 'INSERTED';
      observationId: string;
      observation: CanonicalObservation;
    }
  | {
      kind: 'HASH_CONFLICT';
      observationId: string;
      observation: CanonicalObservation;
    }
  | {
      kind: 'DUPLICATE_DELIVERY';
      observationId: string;
      observation: CanonicalObservation;
    };

type AttemptSnapshot = ReduceEvidenceInput['attempts'][number] & {
  credentialVersionId: string;
  lastObservationAt: Date | null;
  lastOutcomeChangedAt: Date;
  createdAt: Date;
};

type PersistedObservationRow = Omit<
  ProviderObservation,
  'hashAlgorithm' | 'bindingVerification'
> & {
  hashAlgorithm: string;
  bindingVerification: string;
  mappedOutcome: string;
  providerApiVersion: string;
};

interface IngestObservationOptions {
  mutationBoundary?: ShadowMutationBoundary | undefined;
}

export async function ingestObservation(
  prisma: PrismaClient,
  candidate: ObservationCandidate,
  options: IngestObservationOptions = {},
): Promise<IngestionResult> {
  return prisma.$transaction(async (tx) => {
    await lockObligation(tx, candidate.obligationId, candidate.merchantId);
    await lockAttemptsForObligation(tx, candidate.obligationId, candidate.merchantId);

    const obligation = await tx.paymentObligation.findFirst({
      where: { id: candidate.obligationId, merchantId: candidate.merchantId },
    });
    if (!obligation) {
      throw new Error('OBLIGATION_NOT_FOUND');
    }

    const attempts = await listAttemptsForObligation(tx, candidate.obligationId, candidate.merchantId);
    const targetAttempt = attempts.find((attempt) => attempt.id === candidate.attemptId);
    if (!targetAttempt) {
      throw new Error('INTERNAL_REFERENCE_MISMATCH');
    }

    const appended = await appendOrClassifyObservation(tx, candidate);
    const context = await loadReductionContext(
      tx,
      obligation,
      attempts,
      candidate.attemptId,
      appended,
      options,
    );
    const plan = reduceEvidence({
      obligation: {
        id: context.obligation.id,
        merchantId: context.obligation.merchantId,
        amountPaise: context.obligation.amountPaise,
        currency: context.obligation.currency,
        status: context.obligation.status,
      },
      targetAttemptId: candidate.attemptId,
      attempts: context.attempts.map(toReducerAttempt),
      observations: context.observations,
      triggeringObservationId: appended.observationId,
      triggeringObservationIsNew: appended.kind !== 'DUPLICATE_DELIVERY',
    });

    await persistReduction(tx, context, plan);

    const persistedAttempt = await tx.paymentAttempt.findFirst({
      where: {
        id: context.targetAttempt.id,
        obligationId: context.obligation.id,
        merchantId: context.obligation.merchantId,
      },
    });
    if (!persistedAttempt) {
      throw new Error('ATTEMPT_NOT_FOUND_AFTER_REDUCTION');
    }

    return {
      observationId: appended.observationId,
      disposition: plan.disposition,
      outcomeStatus: persistedAttempt.outcomeStatus,
      reviewStatus: persistedAttempt.reviewStatus,
      resolvedAt: persistedAttempt.resolvedAt,
    };
  });
}

/**
 * Persist the policy-driven SLA transition under the same serialized lock
 * order as observation ingestion. The worker passes identifiers rather than
 * mutating a listed attempt snapshot, so a query that resolves concurrently
 * wins and the escalation becomes a no-op.
 */
export async function persistSlaEscalation(
  prisma: PrismaClient,
  input: SlaEscalationRequest,
): Promise<SlaEscalationResult> {
  return prisma.$transaction(async (tx) => {
    await lockObligation(tx, input.obligationId, input.merchantId);
    await lockAttemptsForObligation(tx, input.obligationId, input.merchantId);

    const attempt = await tx.paymentAttempt.findFirst({
      where: {
        id: input.attemptId,
        obligationId: input.obligationId,
        merchantId: input.merchantId,
        resolvedAt: null,
      },
    });

    if (!attempt) {
      return { kind: 'NO_LONGER_UNRESOLVED' };
    }

    const nextOutcomeStatus = attempt.outcomeStatus === 'PENDING'
      ? 'UNKNOWN'
      : attempt.outcomeStatus;
    const nextReviewStatus = attempt.reviewStatus === 'IN_PROGRESS'
      ? 'IN_PROGRESS'
      : 'REQUIRED';
    const outcomeChanged = attempt.outcomeStatus !== nextOutcomeStatus;
    const reviewChanged = attempt.reviewStatus !== nextReviewStatus;

    await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        outcomeStatus: nextOutcomeStatus,
        reviewStatus: nextReviewStatus,
        resolvedAt: null,
        lastOutcomeChangedAt: outcomeChanged
          ? input.observedAt
          : attempt.lastOutcomeChangedAt,
      },
    });

    if (outcomeChanged) {
      await tx.paymentOutcomeTransition.create({
        data: {
          attemptId: attempt.id,
          obligationId: attempt.obligationId,
          merchantId: attempt.merchantId,
          priorOutcomeStatus: attempt.outcomeStatus,
          nextOutcomeStatus,
          reasonCode: input.reason,
          triggeringObservationId: null,
        },
      });
    }

    if (reviewChanged) {
      await tx.reconciliationReviewHistory.create({
        data: {
          attemptId: attempt.id,
          obligationId: attempt.obligationId,
          merchantId: attempt.merchantId,
          priorReviewStatus: attempt.reviewStatus,
          nextReviewStatus,
          completedByType: null,
          actorId: null,
          reasonCode: input.reason,
          triggeringObservationId: null,
          correlationId: null,
        },
      });
    }

    return {
      kind: 'ESCALATED',
      outcomeStatus: nextOutcomeStatus,
      reviewStatus: nextReviewStatus,
    };
  });
}

/**
 * Atomically records rejected provider evidence and queues its security alert.
 * The row contains only canonical identifiers and the body digest—never raw
 * bytes, headers, contact fields, or credential material.
 */
export async function persistProviderSecurityRejection(
  prisma: PrismaClient,
  evidence: ProviderSecurityRejectionEvidence,
): Promise<void> {
  const alertDedupeKey = sha256([
    'pgo1:provider-security-rejection',
    evidence.provider,
    evidence.environment,
    evidence.source,
    evidence.reason,
    evidence.rawBodyHash,
    evidence.attemptId ?? '-',
  ].join(':'));
  const id = `pgo1_rejection_${alertDedupeKey}`;

  await prisma.$executeRaw`
    INSERT INTO "ProviderObservationRejection" (
      "id", "provider", "environment", "source", "reason",
      "merchantId", "obligationId", "attemptId", "credentialBindingId",
      "rawBodyHash", "hashAlgorithm", "signatureVerification", "bindingVerification",
      "adapterVersion", "mappingVersion", "providerApiVersion", "detectedAt",
      "securityAlertCode", "securityAlertStatus", "alertDedupeKey", "createdAt"
    ) VALUES (
      ${id}, ${evidence.provider}::"PaymentProvider",
      ${evidence.environment}::"ProviderEnvironment",
      ${evidence.source}::"ProviderObservationSource", ${evidence.reason},
      ${evidence.merchantId}, ${evidence.obligationId}, ${evidence.attemptId},
      ${evidence.credentialBindingId}, ${evidence.rawBodyHash},
      ${evidence.hashAlgorithm}::"ObservationHashAlgorithm",
      ${evidence.signatureVerification}::"SignatureVerification",
      ${evidence.bindingVerification}::"BindingVerification",
      ${evidence.adapterVersion}, ${evidence.mappingVersion}, ${evidence.providerApiVersion},
      ${evidence.detectedAt}, ${evidence.securityAlertCode}, 'PENDING',
      ${alertDedupeKey}, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("alertDedupeKey") DO NOTHING
  `;
}

export async function persistCredentialUseDenial(
  prisma: PrismaClient,
  input: CredentialDenialPersistenceRequest,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockObligation(tx, input.obligationId, input.merchantId);
    await lockAttemptsForObligation(tx, input.obligationId, input.merchantId);
    const attempt = await tx.paymentAttempt.findFirst({
      where: {
        id: input.attemptId,
        obligationId: input.obligationId,
        merchantId: input.merchantId,
        resolvedAt: null,
      },
    });
    if (!attempt) return;

    const nextOutcomeStatus = 'UNKNOWN' as const;
    const nextReviewStatus = attempt.reviewStatus === 'IN_PROGRESS' ? 'IN_PROGRESS' as const : 'REQUIRED' as const;
    const outcomeChanged = attempt.outcomeStatus !== nextOutcomeStatus;
    const reviewChanged = attempt.reviewStatus !== nextReviewStatus;
    await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        outcomeStatus: nextOutcomeStatus,
        reviewStatus: nextReviewStatus,
        resolvedAt: null,
        lastOutcomeChangedAt: outcomeChanged ? input.observedAt : attempt.lastOutcomeChangedAt,
      },
    });

    if (outcomeChanged) {
      await tx.paymentOutcomeTransition.create({
        data: {
          attemptId: attempt.id,
          obligationId: attempt.obligationId,
          merchantId: attempt.merchantId,
          priorOutcomeStatus: attempt.outcomeStatus,
          nextOutcomeStatus,
          reasonCode: input.reason,
          triggeringObservationId: null,
        },
      });
    }
    if (reviewChanged) {
      await tx.reconciliationReviewHistory.create({
        data: {
          attemptId: attempt.id,
          obligationId: attempt.obligationId,
          merchantId: attempt.merchantId,
          priorReviewStatus: attempt.reviewStatus,
          nextReviewStatus,
          completedByType: null,
          actorId: null,
          reasonCode: input.reason,
          triggeringObservationId: null,
          evidenceReferenceIds: [],
          correlationId: null,
        },
      });
    }

    const priorAlert = await tx.paymentAttentionSignal.findFirst({
      where: {
        attemptId: attempt.id,
        obligationId: attempt.obligationId,
        merchantId: attempt.merchantId,
        signalCode: 'CREDENTIAL_SECURITY_ALERT',
        observationId: null,
      },
    });
    if (!priorAlert) {
      await tx.paymentAttentionSignal.create({
        data: {
          attemptId: attempt.id,
          obligationId: attempt.obligationId,
          merchantId: attempt.merchantId,
          signalCode: 'CREDENTIAL_SECURITY_ALERT',
          observationId: null,
          detail: { reason: input.reason, providerLockPreserved: true },
        },
      });
    }
  });
}

async function lockObligation(tx: Tx, obligationId: string, merchantId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "PaymentObligation"
    WHERE "id" = ${obligationId} AND "merchantId" = ${merchantId}
    FOR UPDATE
  `;

  if (rows.length !== 1) {
    throw new Error('OBLIGATION_NOT_FOUND');
  }
}

async function lockAttemptsForObligation(tx: Tx, obligationId: string, merchantId: string) {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "PaymentAttempt"
    WHERE "obligationId" = ${obligationId} AND "merchantId" = ${merchantId}
    ORDER BY "createdAt" ASC, "id" ASC
    FOR UPDATE
  `;
}

async function listAttemptsForObligation(tx: Tx, obligationId: string, merchantId: string): Promise<AttemptSnapshot[]> {
  return tx.paymentAttempt.findMany({
    where: { obligationId, merchantId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

async function appendOrClassifyObservation(
  tx: Tx,
  candidate: ObservationCandidate,
): Promise<ObservationAppendResult> {
  const eventMatches = candidate.providerEventId
    ? await tx.$queryRaw<PersistedObservationRow[]>`
        SELECT *
        FROM "ProviderObservation"
        WHERE "merchantId" = ${candidate.merchantId}
          AND "obligationId" = ${candidate.obligationId}
          AND "attemptId" = ${candidate.attemptId}
          AND "provider"::text = ${candidate.provider}
          AND "environment"::text = ${candidate.environment}
          AND "providerEventId" = ${candidate.providerEventId}
        ORDER BY "createdAt" ASC, "id" ASC
      `
    : null;
  const exactHashMatch = eventMatches?.find((observation) => observation.rawBodyHash === candidate.rawBodyHash) ?? null;
  const hasEventConflict = (eventMatches?.length ?? 0) > 0;

  if (exactHashMatch) {
    await createDelivery(tx, exactHashMatch, candidate);
    return {
      kind: 'DUPLICATE_DELIVERY',
      observationId: exactHashMatch.id,
      observation: providerObservationRowToCanonical(exactHashMatch),
    };
  }

  const reductionDisposition = hasEventConflict ? 'INTEGRITY_CONFLICT' : candidate.reductionDisposition;
  const observationRow = await tx.providerObservation.create({
    data: {
      id: candidate.id,
      attemptId: candidate.attemptId,
      obligationId: candidate.obligationId,
      merchantId: candidate.merchantId,
      provider: candidate.provider,
      environment: candidate.environment,
      credentialBindingId: candidate.credentialBindingId,
      credentialVersionId: candidate.credentialVersionId,
      source: candidate.source,
      providerEventId: candidate.providerEventId,
      providerOrderRef: candidate.providerOrderRef,
      providerTransactionRef: candidate.providerTransactionRef,
      nativeStatus: candidate.nativeStatus,
      nativeReasonCode: candidate.nativeReasonCode,
      nativeAmountText: candidate.nativeAmountText,
      nativeCurrency: candidate.nativeCurrency,
      amountPaise: candidate.amountPaise,
      rawBodyHash: candidate.rawBodyHash,
      // Prisma exposes the enum member name; PostgreSQL stores its mapped
      // canonical label (`SHA-256`). Raw reloads therefore still validate
      // against the frozen canonical value below.
      hashAlgorithm: 'SHA_256',
      signatureVerification: candidate.signatureVerification,
      bindingVerification: candidate.bindingVerification,
      evidenceAuthority: candidate.evidenceAuthority,
      mappedOutcome: candidate.mappedOutcome,
      adapterVersion: candidate.adapterVersion,
      mappingVersion: candidate.mappingVersion,
      providerApiVersion: candidate.providerApiVersion,
      providerOccurredAt: candidate.providerOccurredAt,
      receivedAt: candidate.receivedAt,
      reductionDisposition,
      observationDedupeKey: observationDedupeKey(candidate),
    } as Prisma.ProviderObservationUncheckedCreateInput,
  }) as PersistedObservationRow;

  await createDelivery(tx, observationRow, candidate);

  return {
    kind: hasEventConflict ? 'HASH_CONFLICT' : 'INSERTED',
    observationId: observationRow.id,
    observation: {
      ...candidate,
      id: observationRow.id,
      reductionDisposition,
    },
  };
}

async function createDelivery(
  tx: Tx,
  observation: Pick<
    ProviderObservation,
    'id' | 'merchantId' | 'attemptId' | 'obligationId'
  >,
  candidate: ObservationCandidate,
) {
  await tx.providerObservationDelivery.create({
    data: {
      observationId: observation.id,
      merchantId: observation.merchantId,
      attemptId: observation.attemptId,
      obligationId: observation.obligationId,
      source: candidate.source,
      providerEventId: candidate.providerEventId,
      rawBodyHash: candidate.rawBodyHash,
      receivedAt: candidate.receivedAt,
    },
  });
}

async function loadReductionContext(
  tx: Tx,
  obligation: PaymentObligation,
  attempts: AttemptSnapshot[],
  targetAttemptId: string,
  appended: ObservationAppendResult,
  options: IngestObservationOptions,
): Promise<ReductionPersistenceContext> {
  const observationRows = await tx.$queryRaw<PersistedObservationRow[]>`
    SELECT *
    FROM "ProviderObservation"
    WHERE "merchantId" = ${obligation.merchantId}
      AND "obligationId" = ${obligation.id}
    ORDER BY "createdAt" ASC, "id" ASC
  `;
  const observations = observationRows.map((row) =>
    row.id === appended.observationId ? appended.observation : providerObservationRowToCanonical(row),
  );
  const targetAttempt = attempts.find((attempt) => attempt.id === targetAttemptId);
  if (!targetAttempt) {
    throw new Error('INTERNAL_REFERENCE_MISMATCH');
  }
  const triggeringObservation = observations.find((observation) => observation.id === appended.observationId);
  if (!triggeringObservation) {
    throw new Error('OBSERVATION_NOT_FOUND');
  }

  return {
    obligation: {
      id: obligation.id,
      merchantId: obligation.merchantId,
      amountPaise: obligation.amountPaise,
      currency: obligation.currency as 'INR',
      status: obligation.status,
      collectionRail: obligation.collectionRail,
      satisfiedAt: obligation.satisfiedAt,
    },
    attempts,
    targetAttempt,
    observations,
    triggeringObservation,
    mutationBoundary: options.mutationBoundary,
  };
}

function toReducerAttempt(attempt: AttemptSnapshot): ReduceEvidenceInput['attempts'][number] {
  return {
    id: attempt.id,
    obligationId: attempt.obligationId,
    merchantId: attempt.merchantId,
    provider: attempt.provider,
    environment: attempt.environment,
    credentialBindingId: attempt.credentialBindingId,
    providerOrderRef: attempt.providerOrderRef,
    requestIdempotencyKey: attempt.requestIdempotencyKey,
    adapterVersion: attempt.adapterVersion,
    mappingVersion: attempt.mappingVersion,
    outcomeStatus: attempt.outcomeStatus,
    reviewStatus: attempt.reviewStatus,
    resolvedAt: attempt.resolvedAt,
  };
}

export function providerObservationRowToCanonical(value: unknown): CanonicalObservation {
  const observation = value as PersistedObservationRow;
  if (observation.hashAlgorithm !== 'SHA-256') {
    throw new Error('INVALID_PERSISTED_HASH_ALGORITHM');
  }
  if (!isSignatureVerification(observation.signatureVerification)) {
    throw new Error('INVALID_PERSISTED_SIGNATURE_VERIFICATION');
  }
  if (observation.bindingVerification !== 'VERIFIED' && observation.bindingVerification !== 'FAILED') {
    throw new Error('INVALID_PERSISTED_BINDING_VERIFICATION');
  }
  if (!isEvidenceAuthority(observation.evidenceAuthority)) {
    throw new Error('INVALID_PERSISTED_EVIDENCE_AUTHORITY');
  }
  if (!isMappedOutcome(observation.mappedOutcome)) {
    throw new Error('INVALID_PERSISTED_MAPPED_OUTCOME');
  }
  if (typeof observation.providerOrderRef !== 'string' || observation.providerOrderRef.trim() === '') {
    throw new Error('INVALID_PERSISTED_PROVIDER_ORDER_REF');
  }
  if (typeof observation.providerApiVersion !== 'string' || observation.providerApiVersion.trim() === '') {
    throw new Error('INVALID_PERSISTED_PROVIDER_API_VERSION');
  }

  return {
    id: observation.id,
    attemptId: observation.attemptId,
    obligationId: observation.obligationId,
    merchantId: observation.merchantId,
    provider: observation.provider,
    environment: observation.environment,
    credentialBindingId: observation.credentialBindingId,
    credentialVersionId: observation.credentialVersionId,
    source: observation.source,
    providerEventId: observation.providerEventId,
    providerOrderRef: observation.providerOrderRef,
    providerTransactionRef: observation.providerTransactionRef,
    nativeStatus: observation.nativeStatus,
    nativeReasonCode: observation.nativeReasonCode,
    amountPaise: observation.amountPaise,
    nativeAmountText: observation.nativeAmountText,
    nativeCurrency: observation.nativeCurrency,
    rawBodyHash: observation.rawBodyHash,
    hashAlgorithm: observation.hashAlgorithm,
    signatureVerification: observation.signatureVerification,
    bindingVerification: observation.bindingVerification,
    evidenceAuthority: observation.evidenceAuthority,
    mappedOutcome: observation.mappedOutcome,
    adapterVersion: observation.adapterVersion,
    mappingVersion: observation.mappingVersion,
    providerApiVersion: observation.providerApiVersion,
    providerOccurredAt: observation.providerOccurredAt,
    receivedAt: observation.receivedAt,
    reductionDisposition: observation.reductionDisposition,
  };
}

function isMappedOutcome(value: string): value is CanonicalObservation['mappedOutcome'] {
  return (
    value === 'PENDING' ||
    value === 'UNKNOWN' ||
    value === 'SUCCEEDED' ||
    value === 'FAILED_TERMINAL' ||
    value === 'NOT_FOUND_TERMINAL' ||
    value === 'UNMAPPED'
  );
}

function isSignatureVerification(value: unknown): value is CanonicalObservation['signatureVerification'] {
  return (
    value === 'VERIFIED' ||
    value === 'FAILED' ||
    value === 'NOT_APPLICABLE' ||
    value === 'UNAVAILABLE'
  );
}

function isEvidenceAuthority(value: unknown): value is CanonicalObservation['evidenceAuthority'] {
  return value === 'ELIGIBLE' || value === 'ACTIVATION_GATED' || value === 'INELIGIBLE';
}

function observationDedupeKey(candidate: ObservationCandidate) {
  return sha256(
    `pgo1:observation:${providerEventIdentity(candidate)}:${candidate.rawBodyHash}`,
  );
}

export function providerEventIdentity(
  candidate: Pick<
    ObservationCandidate,
    'merchantId' | 'obligationId' | 'attemptId' | 'provider' | 'environment' | 'providerEventId' | 'id'
  >,
) {
  return [
    candidate.merchantId,
    candidate.obligationId,
    candidate.provider,
    candidate.environment,
    candidate.attemptId,
    candidate.providerEventId ?? candidate.id,
  ].join(':');
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
