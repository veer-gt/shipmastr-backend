import { createHash } from 'node:crypto';
import { PrismaClient, type CollectionRail, type PaymentAttempt, type PaymentObligation, type ProviderObservation } from '@prisma/client';
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
} from './reconciliationWorker.js';

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

const PERSISTED_PROVIDER_API_VERSION = 'persisted-unavailable';

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
    });

    await persistReduction(tx, context, plan);

    return {
      observationId: appended.observationId,
      disposition: plan.disposition,
      outcomeStatus: plan.outcomeStatus,
      reviewStatus: plan.reviewStatus,
      resolvedAt: plan.resolved
        ? context.targetAttempt.resolvedAt ?? effectiveObservationTime(context.triggeringObservation)
        : null,
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
    ? await tx.providerObservation.findMany({
        where: {
          merchantId: candidate.merchantId,
          obligationId: candidate.obligationId,
          providerEventId: candidate.providerEventId,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    : null;
  const exactHashMatch = eventMatches?.find((observation) => observation.rawBodyHash === candidate.rawBodyHash) ?? null;
  const hasEventConflict = (eventMatches?.length ?? 0) > 0;

  if (exactHashMatch) {
    await createDelivery(tx, exactHashMatch, candidate);
    return {
      kind: 'DUPLICATE_DELIVERY',
      observationId: exactHashMatch.id,
      observation: persistedObservationToCanonical(exactHashMatch),
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
      hashAlgorithm: candidate.hashAlgorithm,
      signatureVerification: candidate.signatureVerification,
      bindingVerification: candidate.bindingVerification,
      evidenceAuthority: candidate.evidenceAuthority,
      adapterVersion: candidate.adapterVersion,
      mappingVersion: candidate.mappingVersion,
      providerOccurredAt: candidate.providerOccurredAt,
      receivedAt: candidate.receivedAt,
      reductionDisposition,
      observationDedupeKey: observationDedupeKey(candidate),
    },
  });

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
  observation: ProviderObservation,
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
  const observationRows = await tx.providerObservation.findMany({
    where: {
      merchantId: obligation.merchantId,
      obligationId: obligation.id,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const observations = observationRows.map((row) =>
    row.id === appended.observationId ? appended.observation : persistedObservationToCanonical(row),
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

function persistedObservationToCanonical(observation: ProviderObservation): CanonicalObservation {
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
    providerOrderRef: observation.providerOrderRef ?? '',
    providerTransactionRef: observation.providerTransactionRef,
    nativeStatus: observation.nativeStatus,
    nativeReasonCode: observation.nativeReasonCode,
    amountPaise: observation.amountPaise,
    nativeAmountText: observation.nativeAmountText,
    nativeCurrency: observation.nativeCurrency,
    rawBodyHash: observation.rawBodyHash,
    hashAlgorithm: normalizeHashAlgorithm(observation.hashAlgorithm),
    signatureVerification: observation.signatureVerification,
    bindingVerification: normalizeBindingVerification(observation.bindingVerification),
    evidenceAuthority: observation.evidenceAuthority,
    mappedOutcome: mappedOutcomeFromDisposition(observation.reductionDisposition),
    adapterVersion: observation.adapterVersion,
    mappingVersion: observation.mappingVersion,
    providerApiVersion: PERSISTED_PROVIDER_API_VERSION,
    providerOccurredAt: observation.providerOccurredAt,
    receivedAt: observation.receivedAt,
    reductionDisposition: observation.reductionDisposition,
  };
}

function mappedOutcomeFromDisposition(disposition: string): CanonicalObservation['mappedOutcome'] {
  switch (disposition) {
    case 'SUCCEEDED':
    case 'CONTRADICTORY_EVIDENCE':
    case 'DOUBLE_SUCCESS_DETECTED':
    case 'LATE_SUCCESS_AFTER_CLOSURE':
      return 'SUCCEEDED';
    case 'TERMINAL_FAILURE':
      return 'FAILED_TERMINAL';
    case 'NOT_FOUND_TERMINAL':
      return 'NOT_FOUND_TERMINAL';
    case 'UNKNOWN':
      return 'UNKNOWN';
    case 'MAPPING_GAP':
      return 'UNMAPPED';
    case 'PENDING':
    case 'INTEGRITY_CONFLICT':
    case 'INTEGRITY_CONFLICT_POST_RESOLUTION':
    default:
      return 'PENDING';
  }
}

function normalizeHashAlgorithm(hashAlgorithm: string): CanonicalObservation['hashAlgorithm'] {
  return hashAlgorithm === 'SHA-256' ? 'SHA-256' : 'SHA-256';
}

function normalizeBindingVerification(value: string): CanonicalObservation['bindingVerification'] {
  return value === 'FAILED' ? 'FAILED' : 'VERIFIED';
}

function observationDedupeKey(candidate: ObservationCandidate) {
  return sha256(
    `pgo1:observation:${candidate.merchantId}:${candidate.obligationId}:${candidate.attemptId}:${candidate.provider}:${candidate.environment}:${candidate.providerEventId ?? candidate.id}:${candidate.rawBodyHash}`,
  );
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function effectiveObservationTime(observation: CanonicalObservation) {
  return observation.providerOccurredAt ?? observation.receivedAt;
}
