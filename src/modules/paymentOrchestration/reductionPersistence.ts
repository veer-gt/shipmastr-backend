import { createHash } from 'node:crypto';
import { Prisma, type PaymentProvider } from '@prisma/client';
import type {
  CanonicalObservation,
  ReductionFactType,
  ReductionPersistenceContext,
  ReductionPlan,
  RefundDueEntry,
  ReviewStatus,
} from './types.js';

const FACT_SCHEMA_VERSION = 'pgo1-fact-v1';
const REDUCER_VERSION = 'pgo1-reducer-v1';
const SHADOW_MUTATION_CATEGORIES = [
  'journal',
  'wallet',
  'settlement',
  'payout',
  'refund',
  'custody',
] as const;
const REVIEW_STATUS_REASON_CODE: Record<ReviewStatus, string> = {
  NOT_REQUIRED: 'REVIEW_NOT_REQUIRED',
  REQUIRED: 'REVIEW_REQUIRED_FROM_OBSERVATION',
  IN_PROGRESS: 'REVIEW_IN_PROGRESS',
  COMPLETED: 'SYSTEM_COMPLETED_BY_TERMINAL_OBSERVATION',
};

type FailureInjectionPoint = 'BEFORE_OUTBOX_INSERT';

let failureInjectionPoint: FailureInjectionPoint | null = null;

export function __setFailureInjectionForTests(point: FailureInjectionPoint | null) {
  failureInjectionPoint = point;
}

export async function persistReduction(
  tx: Prisma.TransactionClient,
  context: ReductionPersistenceContext,
  plan: ReductionPlan,
): Promise<void> {
  await context.mutationBoundary?.assertNoMutationAuthority({
    merchantId: context.obligation.merchantId,
    obligationId: context.obligation.id,
    attemptId: context.targetAttempt.id,
    categories: SHADOW_MUTATION_CATEGORIES,
  });

  const effectiveAt = effectiveObservationTime(context.triggeringObservation);
  const preserveResolvedAttempt =
    context.targetAttempt.resolvedAt !== null &&
    !plan.resolved;
  const nextOutcomeStatus = preserveResolvedAttempt
    ? context.targetAttempt.outcomeStatus
    : plan.outcomeStatus;
  const nextReviewStatus = preserveResolvedAttempt
    ? context.targetAttempt.reviewStatus
    : plan.reviewStatus;
  const nextResolvedAt = preserveResolvedAttempt
    ? context.targetAttempt.resolvedAt
    : plan.resolved
      ? context.targetAttempt.resolvedAt ?? effectiveAt
      : null;
  const outcomeChanged = context.targetAttempt.outcomeStatus !== nextOutcomeStatus;
  const reviewChanged = context.targetAttempt.reviewStatus !== nextReviewStatus;
  const lastObservationAt = maxDate(
    context.targetAttempt.lastObservationAt,
    context.triggeringObservation.receivedAt,
  );

  await tx.paymentAttempt.update({
    where: { id: context.targetAttempt.id },
    data: {
      outcomeStatus: nextOutcomeStatus,
      reviewStatus: nextReviewStatus,
      resolvedAt: nextResolvedAt,
      lastObservationAt,
      lastOutcomeChangedAt: outcomeChanged
        ? effectiveAt
        : context.targetAttempt.lastOutcomeChangedAt,
    },
  });

  if (plan.satisfyObligation && context.obligation.status === 'OPEN') {
    await tx.paymentObligation.update({
      where: { id: context.obligation.id },
      data: {
        status: 'SATISFIED',
        satisfiedAt: context.obligation.satisfiedAt ?? effectiveAt,
      },
    });
  }

  if (outcomeChanged) {
    await tx.paymentOutcomeTransition.create({
      data: {
        attemptId: context.targetAttempt.id,
        obligationId: context.obligation.id,
        merchantId: context.obligation.merchantId,
        priorOutcomeStatus: context.targetAttempt.outcomeStatus,
        nextOutcomeStatus: nextOutcomeStatus,
        reasonCode: outcomeReasonCode(plan),
        triggeringObservationId: context.triggeringObservation.id,
      },
    });
  }

  if (reviewChanged) {
    await tx.reconciliationReviewHistory.create({
      data: {
        attemptId: context.targetAttempt.id,
        obligationId: context.obligation.id,
        merchantId: context.obligation.merchantId,
        priorReviewStatus: context.targetAttempt.reviewStatus,
        nextReviewStatus: nextReviewStatus,
        completedByType: preserveResolvedAttempt ? null : plan.completedByType,
        actorId: null,
        reasonCode: REVIEW_STATUS_REASON_CODE[nextReviewStatus],
        triggeringObservationId: context.triggeringObservation.id,
        evidenceReferenceIds: [context.triggeringObservation.id],
        correlationId: null,
      },
    });
  }

  for (const attention of plan.attention) {
    const existing = await tx.paymentAttentionSignal.findFirst({
      where: {
        attemptId: context.targetAttempt.id,
        obligationId: context.obligation.id,
        merchantId: context.obligation.merchantId,
        signalCode: attention.type,
        observationId: context.triggeringObservation.id,
      },
    });

    if (existing) {
      continue;
    }

    await tx.paymentAttentionSignal.create({
      data: {
        attemptId: context.targetAttempt.id,
        obligationId: context.obligation.id,
        merchantId: context.obligation.merchantId,
        signalCode: attention.type,
        observationId: context.triggeringObservation.id,
        detail: { disposition: plan.disposition },
      },
    });
  }

  for (const refund of plan.refundDue) {
    requireRefundSourceObservation(context, refund);
    await tx.refundDueCase.upsert({
      where: {
        dedupeKey: refund.captureKey,
      },
      update: {},
      create: {
        merchantId: context.obligation.merchantId,
        obligationId: context.obligation.id,
        attemptId: refund.sourceAttemptId,
        provider: refund.provider,
        providerTransactionRef: refund.providerTransactionRef,
        amountPaise: context.obligation.amountPaise,
        currency: context.obligation.currency,
        reason: refund.reason,
        status: 'OPEN',
        dedupeKey: refund.captureKey,
        detectedAt: effectiveAt,
        acknowledgedAt: null,
        escalatedAt: null,
        verifiedClosedAt: null,
        verificationObservationId: null,
      },
    });
  }

  if (failureInjectionPoint === 'BEFORE_OUTBOX_INSERT') {
    throw new Error('INJECTED_FAILURE_BEFORE_OUTBOX_INSERT');
  }

  const factInserts = buildFactInserts(context, plan);
  for (const fact of factInserts) {
    await tx.paymentNormalizedFactOutbox.upsert({
      where: { dedupeKey: fact.dedupeKey },
      update: {},
      create: fact,
    });
  }
}

export function buildFactInserts(
  context: ReductionPersistenceContext,
  plan: ReductionPlan,
) {
  const rows: Prisma.PaymentNormalizedFactOutboxUncheckedCreateInput[] = [];
  for (const emission of plan.factEmissions) {
    const sourceObservation = requireFactSourceObservation(context, emission);
    const refund = emission.factType === 'REFUND_DUE_DETECTED'
      ? requireRefundFactEntry(plan, emission)
      : null;
    rows.push({
      schemaVersion: FACT_SCHEMA_VERSION,
      merchantId: context.obligation.merchantId,
      obligationId: context.obligation.id,
      attemptId: emission.sourceAttemptId,
      triggeringObservationId: emission.sourceObservationId,
      factType: emission.factType,
      amountPaise: context.obligation.amountPaise,
      currency: context.obligation.currency,
      provider: emission.provider,
      providerReferenceId: emission.providerReferenceId,
      reducerVersion: REDUCER_VERSION,
      adapterVersion: sourceObservation.adapterVersion,
      mappingVersion: sourceObservation.mappingVersion,
      dedupeKey: refund?.captureKey ?? factDedupeKey(
        emission.factType,
        emission.sourceAttemptId,
        emission.sourceObservationId,
        emission.providerReferenceId,
      ),
    });
  }

  return rows;
}

function requireRefundSourceObservation(
  context: ReductionPersistenceContext,
  refund: RefundDueEntry,
) {
  const expectedCaptureKey = normalizedCaptureKey(
    context.obligation.merchantId,
    context.obligation.id,
    refund.provider,
    refund.providerTransactionRef,
  );
  if (refund.captureKey !== expectedCaptureKey) {
    throw new Error('REFUND_CAPTURE_IDENTITY_MISMATCH');
  }

  const observation = context.observations.find((entry) =>
    entry.id === refund.sourceObservationId &&
    entry.attemptId === refund.sourceAttemptId &&
    entry.provider === refund.provider &&
    entry.providerTransactionRef === refund.providerTransactionRef,
  );

  if (!observation) {
    throw new Error('REFUND_SOURCE_OBSERVATION_NOT_FOUND');
  }

  return observation;
}

function requireFactSourceObservation(
  context: ReductionPersistenceContext,
  emission: ReductionPlan['factEmissions'][number],
) {
  const observation = context.observations.find((entry) =>
    entry.id === emission.sourceObservationId &&
    entry.attemptId === emission.sourceAttemptId &&
    entry.provider === emission.provider,
  );
  if (!observation) {
    throw new Error('FACT_SOURCE_OBSERVATION_NOT_FOUND');
  }
  return observation;
}

function requireRefundFactEntry(
  plan: ReductionPlan,
  emission: ReductionPlan['factEmissions'][number],
) {
  const refund = plan.refundDue.find((entry) =>
    entry.sourceAttemptId === emission.sourceAttemptId &&
    entry.sourceObservationId === emission.sourceObservationId &&
    entry.provider === emission.provider &&
    entry.providerTransactionRef === emission.providerReferenceId,
  );
  if (!refund) {
    throw new Error('REFUND_FACT_SOURCE_NOT_FOUND');
  }
  return refund;
}

function outcomeReasonCode(plan: ReductionPlan) {
  switch (plan.outcomeStatus) {
    case 'SUCCEEDED':
      return 'OBSERVATION_CONFIRMED_SUCCESS';
    case 'FAILED_TERMINAL':
      return 'OBSERVATION_CONFIRMED_TERMINAL_FAILURE';
    case 'NOT_FOUND_TERMINAL':
      return 'OBSERVATION_CONFIRMED_NOT_FOUND';
    case 'UNKNOWN':
      return 'OBSERVATION_ESCALATED_TO_UNKNOWN';
    case 'PENDING':
      return 'OBSERVATION_LEFT_PENDING';
  }
}

function effectiveObservationTime(observation: CanonicalObservation) {
  return observation.providerOccurredAt ?? observation.receivedAt;
}

function maxDate(left: Date | null, right: Date | null) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left >= right ? left : right;
}

function factDedupeKey(
  factType: ReductionFactType,
  attemptId: string,
  observationId: string,
  providerReferenceId: string,
) {
  return sha256(`pgo1:fact:${factType}:${attemptId}:${observationId}:${providerReferenceId}`);
}

export function normalizedCaptureKey(
  merchantId: string,
  obligationId: string,
  provider: PaymentProvider,
  transactionRef: string,
) {
  return `${merchantId}:${obligationId}:${provider}:${transactionRef}`;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
