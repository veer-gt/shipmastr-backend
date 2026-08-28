import type { PaymentProvider, RefundDueReason } from './types.js';
import { PGO1_MAX_BIGINT_PAISE } from './money.js';

export interface RefundDueDetectedV1 {
  schemaVersion: 'pgo1.refund-due.v1';
  factId: string;
  merchantId: string;
  obligationId: string;
  attemptId: string;
  provider: PaymentProvider;
  providerTransactionRef: string;
  amountPaise: bigint;
  currency: 'INR';
  reason: RefundDueReason;
  dedupeKey: string;
  detectedAt: string;
}

export type RefundQueueCaseStatus =
  | 'OPEN'
  | 'ACKNOWLEDGED'
  | 'MERCHANT_ACTION_PENDING'
  | 'VERIFICATION_PENDING'
  | 'VERIFIED_CLOSED'
  | 'ESCALATED_UNRESOLVED';

type RefundQueueOwner = 'PAYMENTS_OPERATIONS';

type VerificationEvidence =
  | { kind: 'HUMAN_ASSERTION' }
  | {
      kind: 'PROVIDER_REFUND_OBSERVATION';
      providerRefundObservationId: string;
    };

interface RefundQueueClock {
  now(): Date;
  advanceByMs(milliseconds: number): void;
}

interface RefundQueueCase {
  caseId: string;
  owner: RefundQueueOwner;
  status: RefundQueueCaseStatus;
  merchantId: string;
  obligationId: string;
  attemptId: string;
  provider: PaymentProvider;
  providerTransactionRef: string;
  amountPaise: bigint;
  currency: 'INR';
  reason: RefundDueReason;
  dedupeKey: string;
  factId: string;
  detectedAt: string;
  acknowledgedAt: string | null;
  merchantActionRequestedAt: string | null;
  verificationRequestedAt: string | null;
  verifiedClosedAt: string | null;
  verificationObservationId: string | null;
  escalatedAt: string | null;
}

interface ReliabilityEvent {
  type: 'REFUND_DUE_ESCALATED_UNRESOLVED';
  merchantId: string;
  obligationId: string;
  attemptId: string;
  dedupeKey: string;
  containsPii: false;
  occurredAt: string;
}

interface StatusTransition {
  caseId: string;
  fromStatus: RefundQueueCaseStatus;
  toStatus: Exclude<RefundQueueCaseStatus, 'OPEN'>;
  occurredAt: string;
}

const ESCALATION_HORIZON_MS = 72 * 60 * 60 * 1000;
const PGO1_MIN_BIGINT_PAISE = 1n;

export class DeterministicRefundQueueStub {
  readonly #clock: RefundQueueClock;
  readonly #casesByDedupeKey = new Map<string, RefundQueueCase>();
  readonly #caseIds = new Map<string, string>();
  readonly #escalationDueAtByCaseId = new Map<string, number>();
  readonly #reliabilityEvents: ReliabilityEvent[] = [];
  readonly #transitions: StatusTransition[] = [];

  constructor(options: { clock?: RefundQueueClock } = {}) {
    this.#clock = options.clock ?? virtualClock(Date.now());
  }

  consume(event: RefundDueDetectedV1) {
    assertRefundEvent(event);

    if (this.#casesByDedupeKey.has(event.dedupeKey)) {
      return;
    }

    const caseId = `case_${this.#casesByDedupeKey.size + 1}`;
    const next: RefundQueueCase = {
      caseId,
      owner: 'PAYMENTS_OPERATIONS',
      status: 'OPEN',
      merchantId: event.merchantId,
      obligationId: event.obligationId,
      attemptId: event.attemptId,
      provider: event.provider,
      providerTransactionRef: event.providerTransactionRef,
      amountPaise: event.amountPaise,
      currency: event.currency,
      reason: event.reason,
      dedupeKey: event.dedupeKey,
      factId: event.factId,
      detectedAt: event.detectedAt,
      acknowledgedAt: null,
      merchantActionRequestedAt: null,
      verificationRequestedAt: null,
      verifiedClosedAt: null,
      verificationObservationId: null,
      escalatedAt: null,
    };

    this.#casesByDedupeKey.set(event.dedupeKey, next);
    this.#caseIds.set(caseId, event.dedupeKey);
    this.#escalationDueAtByCaseId.set(caseId, this.#clock.now().getTime() + ESCALATION_HORIZON_MS);
  }

  acknowledge(input: { caseId: string }) {
    const current = this.#requireCase(input.caseId);
    this.#transition(current, 'ACKNOWLEDGED', (next, occurredAt) => {
      next.acknowledgedAt = occurredAt;
    });
  }

  requestMerchantAction(input: { caseId: string }) {
    const current = this.#requireCase(input.caseId);
    this.#transition(current, 'MERCHANT_ACTION_PENDING', (next, occurredAt) => {
      next.merchantActionRequestedAt = occurredAt;
    });
  }

  markVerificationPending(input: { caseId: string }) {
    const current = this.#requireCase(input.caseId);
    this.#transition(current, 'VERIFICATION_PENDING', (next, occurredAt) => {
      next.verificationRequestedAt = occurredAt;
    });
  }

  verifyClosed(input: { caseId: string; evidence: VerificationEvidence }) {
    const current = this.#requireCase(input.caseId);
    if (input.evidence.kind !== 'PROVIDER_REFUND_OBSERVATION') {
      throw new Error('MACHINE_VERIFICATION_REQUIRED');
    }
    const providerRefundObservationId = input.evidence.providerRefundObservationId;
    if (providerRefundObservationId.trim() === '') {
      throw new Error('MACHINE_VERIFICATION_REQUIRED');
    }

    this.#transition(current, 'VERIFIED_CLOSED', (next, occurredAt) => {
      next.verifiedClosedAt = occurredAt;
      next.verificationObservationId = providerRefundObservationId;
    });
  }

  advanceToEscalationHorizon() {
    this.#clock.advanceByMs(ESCALATION_HORIZON_MS);
    const occurredAt = this.#clock.now().toISOString();

    for (const entry of this.#casesByDedupeKey.values()) {
      if (entry.status === 'VERIFIED_CLOSED' || entry.status === 'ESCALATED_UNRESOLVED') {
        continue;
      }

      const threshold = this.#escalationDueAtByCaseId.get(entry.caseId) ?? Number.POSITIVE_INFINITY;
      if (this.#clock.now().getTime() < threshold) {
        continue;
      }

      const priorStatus = entry.status;
      entry.status = 'ESCALATED_UNRESOLVED';
      entry.escalatedAt = occurredAt;
      this.#transitions.push({
        caseId: entry.caseId,
        fromStatus: priorStatus,
        toStatus: 'ESCALATED_UNRESOLVED',
        occurredAt,
      });
      this.#reliabilityEvents.push({
        type: 'REFUND_DUE_ESCALATED_UNRESOLVED',
        merchantId: entry.merchantId,
        obligationId: entry.obligationId,
        attemptId: entry.attemptId,
        dedupeKey: entry.dedupeKey,
        containsPii: false,
        occurredAt,
      });
    }
  }

  list() {
    return [...this.#casesByDedupeKey.values()]
      .sort((left, right) => left.caseId.localeCompare(right.caseId))
      .map((entry) => ({ ...entry }));
  }

  history(caseId: string) {
    this.#requireCase(caseId);
    return this.#transitions
      .filter((entry) => entry.caseId === caseId)
      .map((entry) => ({ ...entry }));
  }

  reliabilityEvents() {
    return this.#reliabilityEvents.map((entry) => ({ ...entry }));
  }

  #requireCase(caseId: string) {
    const dedupeKey = this.#caseIds.get(caseId);
    if (!dedupeKey) {
      throw new Error('REFUND_CASE_NOT_FOUND');
    }
    return this.#casesByDedupeKey.get(dedupeKey)!;
  }

  #transition(
    current: RefundQueueCase,
    nextStatus: Exclude<RefundQueueCaseStatus, 'OPEN'>,
    apply: (next: RefundQueueCase, occurredAt: string) => void,
  ) {
    const allowed = ALLOWED_TRANSITIONS[current.status];
    if (!allowed.includes(nextStatus)) {
      throw new Error(`INVALID_STATUS_TRANSITION:${current.status}:${nextStatus}`);
    }

    const occurredAt = this.#clock.now().toISOString();
    const priorStatus = current.status;
    current.status = nextStatus;
    apply(current, occurredAt);
    this.#transitions.push({
      caseId: current.caseId,
      fromStatus: priorStatus,
      toStatus: nextStatus,
      occurredAt,
    });
  }
}

const ALLOWED_TRANSITIONS: Record<RefundQueueCaseStatus, RefundQueueCaseStatus[]> = {
  OPEN: ['ACKNOWLEDGED', 'ESCALATED_UNRESOLVED'],
  ACKNOWLEDGED: ['MERCHANT_ACTION_PENDING', 'ESCALATED_UNRESOLVED'],
  MERCHANT_ACTION_PENDING: ['VERIFICATION_PENDING', 'ESCALATED_UNRESOLVED'],
  VERIFICATION_PENDING: ['VERIFIED_CLOSED', 'ESCALATED_UNRESOLVED'],
  VERIFIED_CLOSED: [],
  ESCALATED_UNRESOLVED: [],
};

export function virtualClock(startAt: number | Date): RefundQueueClock {
  let current = typeof startAt === 'number' ? startAt : startAt.getTime();

  return {
    now() {
      return new Date(current);
    },
    advanceByMs(milliseconds: number) {
      current += milliseconds;
    },
  };
}

function assertRefundEvent(event: RefundDueDetectedV1) {
  if (event.schemaVersion !== 'pgo1.refund-due.v1') {
    throw new Error('INVALID_REFUND_DUE_SCHEMA_VERSION');
  }
  if (event.currency !== 'INR') {
    throw new Error('INVALID_REFUND_DUE_CURRENCY');
  }
  if (event.amountPaise < PGO1_MIN_BIGINT_PAISE || event.amountPaise > PGO1_MAX_BIGINT_PAISE) {
    throw new Error('INVALID_REFUND_DUE_AMOUNT');
  }

  for (const value of [
    event.factId,
    event.merchantId,
    event.obligationId,
    event.attemptId,
    event.providerTransactionRef,
    event.dedupeKey,
    event.detectedAt,
  ]) {
    if (value.trim() === '') {
      throw new Error('INVALID_REFUND_DUE_REFERENCE');
    }
  }
}
