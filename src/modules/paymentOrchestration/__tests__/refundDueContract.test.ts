import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DeterministicRefundQueueStub,
  type RefundDueDetectedV1,
  type RefundQueueCaseStatus,
  virtualClock,
} from '../refundDueContract.js';
import { PGO1_MAX_BIGINT_PAISE } from '../money.js';

function refundEvent(overrides: Partial<RefundDueDetectedV1> = {}): RefundDueDetectedV1 {
  return {
    schemaVersion: 'pgo1.refund-due.v1',
    factId: 'fact_1',
    merchantId: 'm_1',
    obligationId: 'obligation_1',
    attemptId: 'attempt_1',
    provider: 'MOCK',
    providerTransactionRef: 'txn_1',
    amountPaise: 10_000n,
    currency: 'INR',
    reason: 'LATE_SUCCESS_AFTER_CLOSURE',
    dedupeKey: 'dedupe_1',
    detectedAt: '2026-08-28T12:00:00.000Z',
    ...overrides,
  };
}

function seededStub(status: RefundQueueCaseStatus) {
  const stub = new DeterministicRefundQueueStub();
  stub.consume(refundEvent());

  if (status === 'ACKNOWLEDGED') {
    stub.acknowledge({ caseId: 'case_1' });
  }

  if (status === 'MERCHANT_ACTION_PENDING') {
    stub.acknowledge({ caseId: 'case_1' });
    stub.requestMerchantAction({ caseId: 'case_1' });
  }

  if (status === 'VERIFICATION_PENDING') {
    stub.acknowledge({ caseId: 'case_1' });
    stub.requestMerchantAction({ caseId: 'case_1' });
    stub.markVerificationPending({ caseId: 'case_1' });
  }

  if (status === 'VERIFIED_CLOSED') {
    stub.acknowledge({ caseId: 'case_1' });
    stub.requestMerchantAction({ caseId: 'case_1' });
    stub.markVerificationPending({ caseId: 'case_1' });
    stub.verifyClosed({
      caseId: 'case_1',
      evidence: {
        kind: 'PROVIDER_REFUND_OBSERVATION',
        providerRefundObservationId: 'provider_refund_observation_1',
      },
    });
  }

  if (status === 'ESCALATED_UNRESOLVED') {
    stub.advanceToEscalationHorizon();
  }

  return stub;
}

describe('DeterministicRefundQueueStub', () => {
  it('assigns every unique event to Payments Operations exactly once', () => {
    const stub = new DeterministicRefundQueueStub();

    stub.consume(refundEvent());
    stub.consume(refundEvent());

    assert.equal(stub.list().length, 1);
    assert.partialDeepStrictEqual(stub.list()[0], {
      owner: 'PAYMENTS_OPERATIONS',
      status: 'OPEN',
    });
  });

  it('maps both refund reasons without executing money movement', () => {
    const stub = new DeterministicRefundQueueStub();

    stub.consume(refundEvent({ reason: 'LATE_SUCCESS_AFTER_CLOSURE' }));
    stub.consume(
      refundEvent({
        factId: 'fact_2',
        providerTransactionRef: 'txn_2',
        reason: 'SURPLUS_DOUBLE_SUCCESS',
        dedupeKey: 'second',
      }),
    );

    assert.deepEqual(stub.list().map((entry) => entry.reason), [
      'LATE_SUCCESS_AFTER_CLOSURE',
      'SURPLUS_DOUBLE_SUCCESS',
    ]);

    const methods = Object.getOwnPropertyNames(DeterministicRefundQueueStub.prototype);
    for (const name of ['executeRefund', 'refundNow', 'callProvider']) {
      assert.equal(methods.includes(name), false);
    }
  });

  it('rejects human-attested closure', () => {
    const stub = seededStub('VERIFICATION_PENDING');

    assert.throws(
      () =>
        stub.verifyClosed({
          caseId: 'case_1',
          evidence: { kind: 'HUMAN_ASSERTION' },
        }),
      /MACHINE_VERIFICATION_REQUIRED/,
    );
  });

  it('ages to unresolved escalation without optional messaging or scoring consumers', () => {
    const stub = new DeterministicRefundQueueStub({ clock: virtualClock(0) });

    stub.consume(refundEvent());
    stub.advanceToEscalationHorizon();

    assert.partialDeepStrictEqual(stub.list()[0], {
      status: 'ESCALATED_UNRESOLVED',
    });
    assert.equal(stub.reliabilityEvents().length, 1);
    assert.partialDeepStrictEqual(stub.reliabilityEvents()[0], {
      merchantId: 'm_1',
      containsPii: false,
    });
  });

  it('requires a machine-verifiable provider refund observation id to close', () => {
    const stub = seededStub('VERIFICATION_PENDING');

    stub.verifyClosed({
      caseId: 'case_1',
      evidence: {
        kind: 'PROVIDER_REFUND_OBSERVATION',
        providerRefundObservationId: 'provider_refund_observation_1',
      },
    });

    assert.partialDeepStrictEqual(stub.list()[0], {
      status: 'VERIFIED_CLOSED',
      verificationObservationId: 'provider_refund_observation_1',
    });
  });

  it('allows only the listed statuses in deterministic order', () => {
    const stub = seededStub('OPEN');

    stub.acknowledge({ caseId: 'case_1' });
    stub.requestMerchantAction({ caseId: 'case_1' });
    stub.markVerificationPending({ caseId: 'case_1' });
    stub.verifyClosed({
      caseId: 'case_1',
      evidence: {
        kind: 'PROVIDER_REFUND_OBSERVATION',
        providerRefundObservationId: 'provider_refund_observation_2',
      },
    });

    assert.deepEqual(stub.history('case_1').map((entry) => entry.toStatus), [
      'ACKNOWLEDGED',
      'MERCHANT_ACTION_PENDING',
      'VERIFICATION_PENDING',
      'VERIFIED_CLOSED',
    ]);
  });

  it('rejects zero and overflowing refund amounts using the shared INR bounds', () => {
    const stub = new DeterministicRefundQueueStub();

    assert.throws(
      () =>
        stub.consume(
          refundEvent({
            amountPaise: 0n,
            dedupeKey: 'dedupe_zero',
            factId: 'fact_zero',
            providerTransactionRef: 'txn_zero',
          }),
        ),
      /INVALID_REFUND_DUE_AMOUNT/,
    );

    assert.throws(
      () =>
        stub.consume(
          refundEvent({
            amountPaise: PGO1_MAX_BIGINT_PAISE + 1n,
            dedupeKey: 'dedupe_overflow',
            factId: 'fact_overflow',
            providerTransactionRef: 'txn_overflow',
          }),
        ),
      /INVALID_REFUND_DUE_AMOUNT/,
    );
  });
});
