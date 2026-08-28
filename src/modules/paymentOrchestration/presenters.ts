import type {
  OutcomeStatus,
  PaymentProvider,
  ProviderEnvironment,
  RefundDueReason,
  ReviewStatus,
  SignatureVerification,
  BindingVerification,
  EvidenceAuthority,
} from './types.js';

export interface BuyerPaymentStatus {
  code: 'CONFIRMATION_IN_PROGRESS' | 'PAID' | 'FAILED';
  message: string;
  canRetry: boolean;
  canChooseAlternateProvider: boolean;
}

export interface OperatorPaymentReadModel {
  merchantId: string;
  obligationId: string;
  attemptId: string;
  outcomeStatus: OutcomeStatus;
  reviewStatus: ReviewStatus;
  adapterVersion: string;
  mappingVersion: string;
  allowedActions: Array<'REQUEST_READ_ONLY_QUERY' | 'ATTACH_EVIDENCE_REFERENCE'>;
  timeline: ReadonlyArray<Record<string, string>>;
}

export interface RefundDueOperatorReadModel {
  caseId: string;
  merchantId: string;
  obligationId: string;
  attemptId: string;
  reason: RefundDueReason;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'MERCHANT_ACTION_PENDING' | 'VERIFICATION_PENDING' | 'VERIFIED_CLOSED' | 'ESCALATED_UNRESOLVED';
  ageSeconds: number;
  merchantActionStatus: string;
  machineVerificationStatus: string;
  allowedActions: Array<'ACKNOWLEDGE' | 'SEND_REMINDER' | 'ESCALATE' | 'REQUEST_READ_ONLY_VERIFICATION'>;
}

type BuyerAttemptViewInput = {
  outcomeStatus: OutcomeStatus;
  resolvedAt: Date | null;
} & Record<string, unknown>;

type OperatorAttemptInput = {
  id: string;
  merchantId: string;
  obligationId: string;
  outcomeStatus: OutcomeStatus;
  reviewStatus: ReviewStatus;
  adapterVersion: string;
  mappingVersion: string;
  provider: PaymentProvider;
  environment: ProviderEnvironment;
  createdAt: Date;
  lastObservationAt: Date | null;
} & Record<string, unknown>;

type OperatorObservationInput = {
  id: string;
  source: string;
  providerEventId: string | null;
  providerTransactionRef: string | null;
  nativeStatus: string;
  signatureVerification: SignatureVerification;
  bindingVerification: BindingVerification;
  evidenceAuthority: EvidenceAuthority;
  receivedAt: Date;
  providerOccurredAt: Date | null;
  reductionDisposition: string;
  adapterVersion: string;
  mappingVersion: string;
} & Record<string, unknown>;

type OperatorAttentionSignalInput = {
  signalCode: string;
  createdAt: Date;
} & Record<string, unknown>;

type OperatorReviewHistoryInput = {
  nextReviewStatus: ReviewStatus;
  reasonCode: string;
  createdAt: Date;
} & Record<string, unknown>;

type OperatorReadOnlyQueryRequestInput = {
  requestId: string;
  note: string | null;
} & Record<string, unknown>;

type OperatorEvidenceInput = {
  horizonStatus: string;
} & Record<string, unknown>;

type OperatorPaymentReadModelContext = {
  attempt: OperatorAttemptInput;
  observations: OperatorObservationInput[];
  attentionSignals: OperatorAttentionSignalInput[];
  reviewHistory: OperatorReviewHistoryInput[];
  readOnlyQueryRequests: OperatorReadOnlyQueryRequestInput[];
  evidence: OperatorEvidenceInput;
};

type RefundDueOperatorInput = {
  caseId: string;
  merchantId: string;
  obligationId: string;
  attemptId: string;
  reason: RefundDueReason;
  status: RefundDueOperatorReadModel['status'];
  detectedAt: Date;
  acknowledgedAt: Date | null;
  escalatedAt: Date | null;
  verifiedClosedAt: Date | null;
  verificationObservationId: string | null;
} & Record<string, unknown>;

const BUYER_PENDING_MESSAGE =
  'Payment confirmation is still in progress. Do not pay again. We are checking with the payment provider.';
const BUYER_PAID_MESSAGE = 'Payment confirmed. You do not need to pay again.';
const BUYER_FAILED_MESSAGE = 'This payment attempt failed. You can try again or choose a different payment provider.';

const OPERATOR_ALLOWED_ACTIONS: Array<'REQUEST_READ_ONLY_QUERY' | 'ATTACH_EVIDENCE_REFERENCE'> = [
  'REQUEST_READ_ONLY_QUERY',
  'ATTACH_EVIDENCE_REFERENCE',
];

const REFUND_ALLOWED_ACTIONS: Array<'ACKNOWLEDGE' | 'SEND_REMINDER' | 'ESCALATE' | 'REQUEST_READ_ONLY_VERIFICATION'> = [
  'ACKNOWLEDGE',
  'SEND_REMINDER',
  'ESCALATE',
  'REQUEST_READ_ONLY_VERIFICATION',
];

export function toBuyerPaymentStatus(attempt: BuyerAttemptViewInput): BuyerPaymentStatus {
  if (attempt.outcomeStatus === 'SUCCEEDED') {
    return {
      code: 'PAID',
      message: BUYER_PAID_MESSAGE,
      canRetry: false,
      canChooseAlternateProvider: false,
    };
  }

  if (attempt.outcomeStatus === 'UNKNOWN' || attempt.outcomeStatus === 'PENDING') {
    return {
      code: 'CONFIRMATION_IN_PROGRESS',
      message: BUYER_PENDING_MESSAGE,
      canRetry: false,
      canChooseAlternateProvider: false,
    };
  }

  return {
    code: 'FAILED',
    message: BUYER_FAILED_MESSAGE,
    canRetry: true,
    canChooseAlternateProvider: true,
  };
}

export function toOperatorPaymentReadModel(context: OperatorPaymentReadModelContext): OperatorPaymentReadModel {
  const timeline: Record<string, string>[] = [];

  timeline.push(
    buildTimelineEntry({
      category: 'ATTEMPT',
      at: iso(context.attempt.createdAt),
      outcomeStatus: context.attempt.outcomeStatus,
      reviewStatus: context.attempt.reviewStatus,
      provider: context.attempt.provider,
      environment: context.attempt.environment,
      lastObservationAt: isoNullable(context.attempt.lastObservationAt),
    }),
  );

  for (const observation of context.observations) {
    timeline.push(
      buildTimelineEntry({
        category: 'OBSERVATION',
        at: iso(observation.receivedAt),
        source: observation.source,
        providerReference: preferredProviderReference(observation.providerTransactionRef, observation.providerEventId),
        nativeStatus: observation.nativeStatus,
        signatureVerification: observation.signatureVerification,
        bindingVerification: observation.bindingVerification,
        evidenceAuthority: observation.evidenceAuthority,
        providerOccurredAt: isoNullable(observation.providerOccurredAt),
        reductionDisposition: observation.reductionDisposition,
        adapterVersion: observation.adapterVersion,
        mappingVersion: observation.mappingVersion,
      }),
    );
  }

  for (const signal of context.attentionSignals) {
    timeline.push(
      buildTimelineEntry({
        category: 'ALERT',
        at: iso(signal.createdAt),
        signalCode: signal.signalCode,
      }),
    );
  }

  for (const review of context.reviewHistory) {
    timeline.push(
      buildTimelineEntry({
        category: 'REVIEW',
        at: iso(review.createdAt),
        nextReviewStatus: review.nextReviewStatus,
        reasonCode: review.reasonCode,
      }),
    );
  }

  for (const request of context.readOnlyQueryRequests) {
    timeline.push(
      buildTimelineEntry({
        category: 'READ_ONLY_QUERY',
        at: '',
        requestId: request.requestId,
        note: request.note ?? 'NONE',
      }),
    );
  }

  timeline.push(
    buildTimelineEntry({
      category: 'EVIDENCE_HORIZON',
      at: '',
      state: context.evidence.horizonStatus,
    }),
  );

  timeline.sort(compareTimelineEntries);

  return {
    merchantId: context.attempt.merchantId,
    obligationId: context.attempt.obligationId,
    attemptId: context.attempt.id,
    outcomeStatus: context.attempt.outcomeStatus,
    reviewStatus: context.attempt.reviewStatus,
    adapterVersion: context.attempt.adapterVersion,
    mappingVersion: context.attempt.mappingVersion,
    allowedActions: cloneOperatorActions(),
    timeline,
  };
}

export function toRefundDueOperatorReadModel(input: RefundDueOperatorInput): RefundDueOperatorReadModel {
  return {
    caseId: input.caseId,
    merchantId: input.merchantId,
    obligationId: input.obligationId,
    attemptId: input.attemptId,
    reason: input.reason,
    status: input.status,
    ageSeconds: computeAgeSeconds(input.detectedAt),
    merchantActionStatus: merchantActionStatusFor(input.status, input.acknowledgedAt),
    machineVerificationStatus: machineVerificationStatusFor(input.status, input.verifiedClosedAt, input.verificationObservationId),
    allowedActions: cloneRefundActions(),
  };
}

function buildTimelineEntry(fields: Record<string, string>) {
  const entry: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    entry[key] = value;
  }
  return entry;
}

function preferredProviderReference(providerTransactionRef: string | null, providerEventId: string | null) {
  if (providerTransactionRef && providerTransactionRef.trim() !== '') {
    return providerTransactionRef;
  }
  if (providerEventId && providerEventId.trim() !== '') {
    return providerEventId;
  }
  return 'UNAVAILABLE';
}

function compareTimelineEntries(left: Record<string, string>, right: Record<string, string>) {
  const leftAt = left.at ?? '';
  const rightAt = right.at ?? '';
  return leftAt.localeCompare(rightAt);
}

function iso(value: Date) {
  return value.toISOString();
}

function isoNullable(value: Date | null) {
  return value ? value.toISOString() : 'NONE';
}

function computeAgeSeconds(detectedAt: Date) {
  const ageMs = Date.now() - detectedAt.getTime();
  if (ageMs <= 0) {
    return 0;
  }
  return Math.floor(ageMs / 1000);
}

function merchantActionStatusFor(status: RefundDueOperatorReadModel['status'], acknowledgedAt: Date | null) {
  if (status === 'MERCHANT_ACTION_PENDING') {
    return 'ACTION_REQUESTED';
  }
  if (status === 'VERIFICATION_PENDING') {
    return 'AWAITING_VERIFICATION';
  }
  if (status === 'VERIFIED_CLOSED') {
    return 'COMPLETED';
  }
  if (status === 'ESCALATED_UNRESOLVED') {
    return 'ESCALATED';
  }
  if (acknowledgedAt) {
    return 'ACKNOWLEDGED';
  }
  return 'NOT_REQUESTED';
}

function machineVerificationStatusFor(
  status: RefundDueOperatorReadModel['status'],
  verifiedClosedAt: Date | null,
  verificationObservationId: string | null,
) {
  if (verifiedClosedAt && verificationObservationId) {
    return 'VERIFIED';
  }
  if (status === 'VERIFICATION_PENDING') {
    return 'VERIFICATION_REQUESTED';
  }
  return 'NOT_VERIFIED';
}

function cloneOperatorActions(): Array<'REQUEST_READ_ONLY_QUERY' | 'ATTACH_EVIDENCE_REFERENCE'> {
  return ['REQUEST_READ_ONLY_QUERY', 'ATTACH_EVIDENCE_REFERENCE'];
}

function cloneRefundActions(): Array<'ACKNOWLEDGE' | 'SEND_REMINDER' | 'ESCALATE' | 'REQUEST_READ_ONLY_VERIFICATION'> {
  return ['ACKNOWLEDGE', 'SEND_REMINDER', 'ESCALATE', 'REQUEST_READ_ONLY_VERIFICATION'];
}
