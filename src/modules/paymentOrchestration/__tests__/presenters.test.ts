import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  toBuyerPaymentStatus,
  toOperatorPaymentReadModel,
  toRefundDueOperatorReadModel,
} from '../presenters.js';

type BuyerAttemptInput = Parameters<typeof toBuyerPaymentStatus>[0];
type OperatorContextInput = Parameters<typeof toOperatorPaymentReadModel>[0];
type RefundCaseInput = Parameters<typeof toRefundDueOperatorReadModel>[0];

function attempt(overrides: Partial<BuyerAttemptInput & OperatorContextInput['attempt']> = {}): BuyerAttemptInput & OperatorContextInput['attempt'] {
  return {
    id: 'attempt_1',
    merchantId: 'merchant_1',
    obligationId: 'obligation_1',
    outcomeStatus: 'PENDING',
    reviewStatus: 'NOT_REQUIRED',
    resolvedAt: null,
    adapterVersion: 'adapter_v1',
    mappingVersion: 'mapping_v1',
    provider: 'PAYTM',
    environment: 'TEST',
    createdAt: new Date('2026-08-28T10:00:00.000Z'),
    lastObservationAt: new Date('2026-08-28T10:01:00.000Z'),
    ...overrides,
  };
}

function operatorContext(overrides: Partial<OperatorContextInput> = {}): OperatorContextInput {
  return {
    attempt: attempt({
      outcomeStatus: 'UNKNOWN',
      reviewStatus: 'IN_PROGRESS',
      resolvedAt: null,
    }),
    observations: [
      {
        id: 'observation_1',
        source: 'WEBHOOK',
        providerEventId: 'event_1',
        providerTransactionRef: 'txn_opaque_1',
        nativeStatus: 'PENDING_REVIEW',
        signatureVerification: 'VERIFIED',
        bindingVerification: 'VERIFIED',
        evidenceAuthority: 'ACTIVATION_GATED',
        receivedAt: new Date('2026-08-28T10:02:00.000Z'),
        providerOccurredAt: new Date('2026-08-28T10:01:30.000Z'),
        reductionDisposition: 'ACCEPTED',
        adapterVersion: 'adapter_v1',
        mappingVersion: 'mapping_v1',
        rawBodyHash: 'hash_1',
        credentialVersionId: 'credential_version_1',
        buyerPhone: '+919999999999',
        buyerEmail: 'buyer@example.test',
      },
    ],
    attentionSignals: [
      {
        signalCode: 'MAPPING_GAP',
        createdAt: new Date('2026-08-28T10:03:00.000Z'),
      },
    ],
    reviewHistory: [
      {
        nextReviewStatus: 'IN_PROGRESS',
        reasonCode: 'REVIEW_REQUIRED_FROM_OBSERVATION',
        createdAt: new Date('2026-08-28T10:04:00.000Z'),
      },
    ],
    readOnlyQueryRequests: [
      {
        requestId: 'query_1',
        note: 'merchant requested verification',
      },
    ],
    evidence: {
      horizonStatus: 'WITHIN_WINDOW',
    },
    ...overrides,
  };
}

function refundCase(overrides: Partial<RefundCaseInput> & Record<string, unknown> = {}): RefundCaseInput {
  return {
    caseId: 'case_1',
    merchantId: 'merchant_1',
    obligationId: 'obligation_1',
    attemptId: 'attempt_1',
    reason: 'LATE_SUCCESS_AFTER_CLOSURE',
    status: 'MERCHANT_ACTION_PENDING',
    detectedAt: new Date('2026-08-28T08:00:00.000Z'),
    acknowledgedAt: new Date('2026-08-28T08:05:00.000Z'),
    escalatedAt: null,
    verifiedClosedAt: null,
    verificationObservationId: null,
    ...overrides,
  };
}

describe('payment orchestration presenters', () => {
  it('tells an ambiguous buyer not to pay again', () => {
    assert.deepEqual(
      toBuyerPaymentStatus(attempt({ outcomeStatus: 'UNKNOWN', resolvedAt: null })),
      {
        code: 'CONFIRMATION_IN_PROGRESS',
        message: 'Payment confirmation is still in progress. Do not pay again. We are checking with the payment provider.',
        canRetry: false,
        canChooseAlternateProvider: false,
      },
    );
  });

  it('treats a terminal outcome as failed while preserving the retry choice', () => {
    assert.deepEqual(
      toBuyerPaymentStatus(attempt({ outcomeStatus: 'FAILED_TERMINAL', resolvedAt: new Date('2026-08-28T10:05:00.000Z') })),
      {
        code: 'FAILED',
        message: 'This payment attempt failed. You can try again or choose a different payment provider.',
        canRetry: true,
        canChooseAlternateProvider: true,
      },
    );
  });

  it('exposes normalized operator evidence but no raw or secret fields', () => {
    const model = toOperatorPaymentReadModel(operatorContext());

    assert.deepEqual(Object.keys(model).sort(), [
      'adapterVersion',
      'allowedActions',
      'attemptId',
      'mappingVersion',
      'merchantId',
      'obligationId',
      'outcomeStatus',
      'reviewStatus',
      'timeline',
    ]);
    assert.partialDeepStrictEqual(model, {
      merchantId: 'merchant_1',
      obligationId: 'obligation_1',
      attemptId: 'attempt_1',
      outcomeStatus: 'UNKNOWN',
      reviewStatus: 'IN_PROGRESS',
      adapterVersion: 'adapter_v1',
      mappingVersion: 'mapping_v1',
    });
    assert.deepEqual(model.allowedActions, ['REQUEST_READ_ONLY_QUERY', 'ATTACH_EVIDENCE_REFERENCE']);
    assert.ok(model.timeline.some((entry) => entry.category === 'OBSERVATION' && entry.providerReference === 'txn_opaque_1'));
    assert.ok(model.timeline.some((entry) => entry.category === 'ALERT' && entry.signalCode === 'MAPPING_GAP'));
    assert.ok(model.timeline.some((entry) => entry.category === 'EVIDENCE_HORIZON' && entry.state === 'WITHIN_WINDOW'));
    assert.doesNotMatch(JSON.stringify(model), /rawBody|credentialVersionId|secret|buyerPhone|buyerEmail/i);
  });

  it('shows refund accountability without an execution control', (t) => {
    t.mock.method(Date, 'now', () => Date.parse('2026-08-28T10:00:00.000Z'));

    const model = toRefundDueOperatorReadModel(refundCase());

    assert.deepEqual(Object.keys(model).sort(), [
      'ageSeconds',
      'allowedActions',
      'attemptId',
      'caseId',
      'machineVerificationStatus',
      'merchantActionStatus',
      'merchantId',
      'obligationId',
      'reason',
      'status',
    ]);
    assert.deepEqual(model.allowedActions, [
      'ACKNOWLEDGE',
      'SEND_REMINDER',
      'ESCALATE',
      'REQUEST_READ_ONLY_VERIFICATION',
    ]);
    assert.equal(model.ageSeconds, 7200);
    assert.equal(model.merchantActionStatus, 'ACTION_REQUESTED');
    assert.equal(model.machineVerificationStatus, 'NOT_VERIFIED');
    assert.doesNotMatch(JSON.stringify(model), /executeRefund|refundNow|providerCredential|secret/i);
  });
});
