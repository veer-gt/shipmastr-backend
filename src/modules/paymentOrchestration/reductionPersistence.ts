import { createHash } from 'node:crypto';
import { Prisma, type PaymentProvider } from '@prisma/client';
import type {
  CanonicalObservation,
  ReductionFactType,
  ReductionPersistenceContext,
  ReductionPlan,
  ReviewStatus,
} from './types.js';

const FACT_SCHEMA_VERSION = 'pgo1-fact-v1';
const REDUCER_VERSION = 'pgo1-reducer-v1';
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

  await tx.providerObservation.update({
    where: { id: context.triggeringObservation.id },
    data: {
      reductionDisposition: observationDisposition(context, plan),
    },
  });

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
    await tx.refundDueCase.upsert({
      where: {
        dedupeKey: refundDedupeKey(
          context.obligation.merchantId,
          context.obligation.id,
          context.targetAttempt.provider,
          refund.providerTransactionRef,
        ),
      },
      update: {},
      create: {
        merchantId: context.obligation.merchantId,
        obligationId: context.obligation.id,
        attemptId: context.targetAttempt.id,
        provider: context.targetAttempt.provider,
        providerTransactionRef: refund.providerTransactionRef,
        amountPaise: context.obligation.amountPaise,
        currency: context.obligation.currency,
        reason: refund.reason,
        status: 'OPEN',
        dedupeKey: refundDedupeKey(
          context.obligation.merchantId,
          context.obligation.id,
          context.targetAttempt.provider,
          refund.providerTransactionRef,
        ),
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

function buildFactInserts(
  context: ReductionPersistenceContext,
  plan: ReductionPlan,
) {
  const base = {
    schemaVersion: FACT_SCHEMA_VERSION,
    merchantId: context.obligation.merchantId,
    obligationId: context.obligation.id,
    attemptId: context.targetAttempt.id,
    triggeringObservationId: context.triggeringObservation.id,
    amountPaise: context.obligation.amountPaise,
    currency: context.obligation.currency,
    provider: context.targetAttempt.provider,
    reducerVersion: REDUCER_VERSION,
    adapterVersion: context.triggeringObservation.adapterVersion,
    mappingVersion: context.triggeringObservation.mappingVersion,
  } satisfies Omit<
    Prisma.PaymentNormalizedFactOutboxUncheckedCreateInput,
    'factType' | 'providerReferenceId' | 'dedupeKey'
  >;

  const rows: Prisma.PaymentNormalizedFactOutboxUncheckedCreateInput[] = [];

  for (const factType of plan.factTypes) {
    if (factType === 'REFUND_DUE_DETECTED') {
      for (const refund of plan.refundDue) {
        rows.push({
          ...base,
          factType,
          providerReferenceId: refund.providerTransactionRef,
          dedupeKey: factDedupeKey(
            factType,
            context.targetAttempt.id,
            context.triggeringObservation.id,
            refund.providerTransactionRef,
          ),
        });
      }
      continue;
    }

    rows.push({
      ...base,
      factType,
      providerReferenceId: providerReferenceIdForFact(context.triggeringObservation, factType),
      dedupeKey: factDedupeKey(
        factType,
        context.targetAttempt.id,
        context.triggeringObservation.id,
        context.triggeringObservation.providerTransactionRef,
      ),
    });
  }

  return rows;
}

function providerReferenceIdForFact(
  observation: CanonicalObservation,
  factType: Exclude<ReductionFactType, 'REFUND_DUE_DETECTED'>,
) {
  if (factType === 'PAYMENT_SUCCEEDED') {
    return observation.providerTransactionRef ?? observation.providerEventId ?? observation.id;
  }

  return observation.providerEventId ?? observation.id;
}

function observationDisposition(
  context: ReductionPersistenceContext,
  plan: ReductionPlan,
) {
  if (plan.disposition.startsWith('INTEGRITY_CONFLICT')) {
    return 'INTEGRITY_CONFLICT';
  }

  return plan.disposition;
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
  transactionRef: string | null,
) {
  return sha256(`pgo1:fact:${factType}:${attemptId}:${observationId}:${transactionRef ?? '-'}`);
}

function refundDedupeKey(
  merchantId: string,
  obligationId: string,
  provider: PaymentProvider,
  transactionRef: string,
) {
  return sha256(`pgo1:refund-due:${merchantId}:${obligationId}:${provider}:${transactionRef}`);
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
