import { randomUUID } from 'node:crypto';
import { PrismaClient, type PaymentAttempt, type ReconciliationReviewHistory } from '@prisma/client';
import { HttpError } from '../../lib/httpError.js';
import { audit } from '../audit/audit.service.js';
import type {
  PaymentProvider,
  ProviderEnvironment,
  ReviewStatus,
} from './types.js';

const EVIDENCE_REFERENCE_MAX_LENGTH = 240;
const OPERATIONAL_NOTE_MAX_LENGTH = 240;

const emailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const longDigitPattern = /\d(?:[^\d]*\d){9,}/;
const ipv4Pattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const directPiiTermPattern = /\b(buyer|customer|email|phone|mobile|address)\b/i;
const postalPattern = /\b(street|road|lane|avenue|sector|flat|floor|house|market)\b/i;

type Tx = Parameters<PrismaClient['$transaction']>[0] extends (tx: infer T) => unknown ? T : never;

export const MANUAL_EVIDENCE_EXCEPTION_GATE = false as const;

export interface ClaimReviewInput {
  attemptId: string;
  reviewerId: string;
}

export interface AttachEvidenceReferenceInput {
  attemptId: string;
  reviewerId: string;
  reference: string;
}

export interface RequestReadOnlyQueryInput {
  attemptId: string;
  reviewerId: string;
  note?: string;
  requestId?: string;
}

export interface ViewReviewInput {
  attemptId: string;
}

export interface ReviewHistoryEntry {
  id: string;
  priorReviewStatus: ReviewStatus;
  nextReviewStatus: ReviewStatus;
  completedByType: 'SYSTEM' | 'REVIEWER' | null;
  actorId: string | null;
  reasonCode: string;
  triggeringObservationId: string | null;
  evidenceReferenceIds: string[];
  correlationId: string | null;
  createdAt: Date;
}

export interface ReviewView {
  attempt: Pick<
    PaymentAttempt,
    | 'id'
    | 'obligationId'
    | 'merchantId'
    | 'provider'
    | 'environment'
    | 'credentialBindingId'
    | 'credentialVersionId'
    | 'outcomeStatus'
    | 'reviewStatus'
    | 'resolvedAt'
  >;
  history: ReviewHistoryEntry[];
}

export interface ReadOnlyQueryRequest {
  kind: 'READ_ONLY_QUERY_REQUESTED';
  requestId: string;
  attemptId: string;
  obligationId: string;
  merchantId: string;
  provider: PaymentProvider;
  environment: ProviderEnvironment;
  credentialBindingId: string;
  credentialVersionId: string;
  operation: 'STATUS_QUERY';
  note: string | null;
}

export interface GovernanceTriggerInput {
  horizonExceeded: boolean;
  everyMachineChannelExhausted: boolean;
  credibleRealMoneyExposure: boolean;
}

export type GovernanceTriggerDecision =
  | { convene: false }
  | {
      convene: true;
      paymentStateMutation: false;
      unlockProvider: false;
      replayAllowed: false;
      dualControlActivated: false;
    };

export async function claimReview(
  prisma: PrismaClient,
  input: ClaimReviewInput,
): Promise<ReviewView> {
  const reviewerId = cleanActorId(input.reviewerId);

  return prisma.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);
    assertClaimableAttempt(attempt);

    if (attempt.reviewStatus === 'IN_PROGRESS') {
      return loadReviewView(tx, attempt.id);
    }

    await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: { reviewStatus: 'IN_PROGRESS' },
    });
    await tx.reconciliationReviewHistory.create({
      data: {
        attemptId: attempt.id,
        obligationId: attempt.obligationId,
        merchantId: attempt.merchantId,
        priorReviewStatus: attempt.reviewStatus,
        nextReviewStatus: 'IN_PROGRESS',
        completedByType: null,
        actorId: reviewerId,
        reasonCode: 'REVIEW_CLAIMED',
        triggeringObservationId: null,
        evidenceReferenceIds: [],
        correlationId: null,
      },
    });

    return loadReviewView(tx, attempt.id);
  });
}

export async function attachEvidenceReference(
  prisma: PrismaClient,
  input: AttachEvidenceReferenceInput,
): Promise<ReviewView> {
  const reviewerId = cleanActorId(input.reviewerId);
  const attemptForValidation = await loadAttemptForValidation(prisma, input.attemptId);
  const reference = await validateAuditedEvidenceInput(
    prisma,
    attemptForValidation,
    reviewerId,
    'reference',
    input.reference,
  );

  return prisma.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);
    assertInProgressAttempt(attempt);

    await tx.reconciliationReviewHistory.create({
      data: {
        attemptId: attempt.id,
        obligationId: attempt.obligationId,
        merchantId: attempt.merchantId,
        priorReviewStatus: 'IN_PROGRESS',
        nextReviewStatus: 'IN_PROGRESS',
        completedByType: null,
        actorId: reviewerId,
        reasonCode: 'EVIDENCE_REFERENCE_ATTACHED',
        triggeringObservationId: null,
        evidenceReferenceIds: [reference],
        correlationId: null,
      },
    });

    return loadReviewView(tx, attempt.id);
  });
}

export async function requestReadOnlyQuery(
  prisma: PrismaClient,
  input: RequestReadOnlyQueryInput,
): Promise<ReadOnlyQueryRequest> {
  const reviewerId = cleanActorId(input.reviewerId);
  const attemptForValidation = await loadAttemptForValidation(prisma, input.attemptId);
  const note = input.note === undefined
    ? null
    : await validateAuditedEvidenceInput(
        prisma,
        attemptForValidation,
        reviewerId,
        'note',
        input.note,
      );
  const requestId = cleanOptional(input.requestId) ?? `review_query_${randomUUID()}`;

  return prisma.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);
    assertInProgressAttempt(attempt);

    await tx.reconciliationReviewHistory.create({
      data: {
        attemptId: attempt.id,
        obligationId: attempt.obligationId,
        merchantId: attempt.merchantId,
        priorReviewStatus: 'IN_PROGRESS',
        nextReviewStatus: 'IN_PROGRESS',
        completedByType: null,
        actorId: reviewerId,
        reasonCode: 'READ_ONLY_QUERY_REQUESTED',
        triggeringObservationId: null,
        evidenceReferenceIds: [],
        correlationId: requestId,
      },
    });

    return {
      kind: 'READ_ONLY_QUERY_REQUESTED',
      requestId,
      attemptId: attempt.id,
      obligationId: attempt.obligationId,
      merchantId: attempt.merchantId,
      provider: attempt.provider as PaymentProvider,
      environment: attempt.environment as ProviderEnvironment,
      credentialBindingId: attempt.credentialBindingId,
      credentialVersionId: attempt.credentialVersionId,
      operation: 'STATUS_QUERY',
      note,
    };
  });
}

export async function viewReview(
  prisma: PrismaClient,
  input: ViewReviewInput,
): Promise<ReviewView> {
  return loadReviewView(prisma, input.attemptId);
}

export const reviewService = {
  claimReview,
  attachEvidenceReference,
  requestReadOnlyQuery,
  viewReview,
} as const;

export function evaluateEvidenceHorizonGovernanceTrigger(
  input: GovernanceTriggerInput,
): GovernanceTriggerDecision {
  if (
    !input.horizonExceeded
    || !input.everyMachineChannelExhausted
    || !input.credibleRealMoneyExposure
  ) {
    return { convene: false };
  }

  return {
    convene: true,
    paymentStateMutation: false,
    unlockProvider: false,
    replayAllowed: false,
    dualControlActivated: false,
  };
}

async function loadAttemptForValidation(
  prisma: PrismaClient,
  attemptId: string,
): Promise<Pick<PaymentAttempt, 'id' | 'merchantId' | 'reviewStatus' | 'resolvedAt'>> {
  const attempt = await prisma.paymentAttempt.findUnique({
    where: { id: attemptId },
    select: {
      id: true,
      merchantId: true,
      reviewStatus: true,
      resolvedAt: true,
    },
  });

  if (!attempt) {
    throw new HttpError(404, 'ATTEMPT_NOT_FOUND');
  }

  return attempt;
}

async function validateAuditedEvidenceInput(
  prisma: PrismaClient,
  attempt: Pick<PaymentAttempt, 'id' | 'merchantId'>,
  reviewerId: string,
  field: 'reference' | 'note',
  rawValue: string,
): Promise<string> {
  try {
    return validateEvidenceInput(field, rawValue);
  } catch (error) {
    if (error instanceof HttpError) {
      await audit({
        actorId: reviewerId,
        action: 'PGO1_REVIEW_INPUT_REJECTED',
        entityType: 'PaymentAttempt',
        entityId: attempt.id,
        metadata: {
          status: 'rejected',
          field,
          reason: error.message,
        },
      }, prisma);
    }

    throw error;
  }
}

function validateEvidenceInput(
  field: 'reference' | 'note',
  rawValue: string,
): string {
  const value = cleanRequired(
    rawValue,
    field === 'reference' ? 'EVIDENCE_REFERENCE_REQUIRED' : 'EVIDENCE_NOTE_REQUIRED',
  );
  const maxLength = field === 'reference'
    ? EVIDENCE_REFERENCE_MAX_LENGTH
    : OPERATIONAL_NOTE_MAX_LENGTH;

  if (value.length > maxLength) {
    throw new HttpError(
      400,
      field === 'reference' ? 'EVIDENCE_REFERENCE_TOO_LONG' : 'EVIDENCE_NOTE_TOO_LONG',
    );
  }

  if (
    emailPattern.test(value)
    || longDigitPattern.test(value)
    || ipv4Pattern.test(value)
    || directPiiTermPattern.test(value)
    || postalPattern.test(value)
  ) {
    throw new HttpError(400, 'PROHIBITED_EVIDENCE_PII');
  }

  return value;
}

function cleanActorId(value: string): string {
  const actorId = cleanRequired(value, 'REVIEWER_ID_REQUIRED');
  if (actorId.length > 120) {
    throw new HttpError(400, 'REVIEWER_ID_TOO_LONG');
  }
  return actorId;
}

function cleanRequired(value: string, code: string): string {
  const next = value.trim();
  if (!next) {
    throw new HttpError(400, code);
  }
  return next;
}

function cleanOptional(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const next = value.trim();
  return next ? next : null;
}

function assertClaimableAttempt(
  attempt: Pick<PaymentAttempt, 'reviewStatus' | 'resolvedAt'>,
) {
  if (attempt.resolvedAt !== null || attempt.reviewStatus === 'COMPLETED') {
    throw new HttpError(409, 'REVIEW_ALREADY_COMPLETED');
  }

  if (attempt.reviewStatus === 'NOT_REQUIRED') {
    throw new HttpError(409, 'REVIEW_NOT_REQUIRED');
  }
}

function assertInProgressAttempt(
  attempt: Pick<PaymentAttempt, 'reviewStatus' | 'resolvedAt'>,
) {
  if (attempt.resolvedAt !== null || attempt.reviewStatus === 'COMPLETED') {
    throw new HttpError(409, 'REVIEW_ALREADY_COMPLETED');
  }

  if (attempt.reviewStatus !== 'IN_PROGRESS') {
    throw new HttpError(409, 'REVIEW_NOT_IN_PROGRESS');
  }
}

async function lockAttempt(
  tx: Tx,
  attemptId: string,
): Promise<PaymentAttempt> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "PaymentAttempt"
    WHERE "id" = ${attemptId}
    FOR UPDATE
  `;

  if (rows.length !== 1) {
    throw new HttpError(404, 'ATTEMPT_NOT_FOUND');
  }

  return tx.paymentAttempt.findUniqueOrThrow({
    where: { id: attemptId },
  });
}

async function loadReviewView(
  client: PrismaClient | Tx,
  attemptId: string,
): Promise<ReviewView> {
  const attempt = await client.paymentAttempt.findUnique({
    where: { id: attemptId },
    select: {
      id: true,
      obligationId: true,
      merchantId: true,
      provider: true,
      environment: true,
      credentialBindingId: true,
      credentialVersionId: true,
      outcomeStatus: true,
      reviewStatus: true,
      resolvedAt: true,
    },
  });

  if (!attempt) {
    throw new HttpError(404, 'ATTEMPT_NOT_FOUND');
  }

  const history = await client.reconciliationReviewHistory.findMany({
    where: { attemptId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  return {
    attempt,
    history: history.map(toReviewHistoryEntry),
  };
}

function toReviewHistoryEntry(
  entry: ReconciliationReviewHistory,
): ReviewHistoryEntry {
  return {
    id: entry.id,
    priorReviewStatus: entry.priorReviewStatus as ReviewStatus,
    nextReviewStatus: entry.nextReviewStatus as ReviewStatus,
    completedByType: entry.completedByType,
    actorId: entry.actorId,
    reasonCode: entry.reasonCode,
    triggeringObservationId: entry.triggeringObservationId,
    evidenceReferenceIds: toStringArray(entry.evidenceReferenceIds),
    correlationId: entry.correlationId,
    createdAt: entry.createdAt,
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}
