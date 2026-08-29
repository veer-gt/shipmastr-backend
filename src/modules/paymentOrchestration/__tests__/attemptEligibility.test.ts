import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PaymentObligation } from '@prisma/client';
import { assertAttemptEligible } from '../attemptCoordinator.js';

function obligation(
  overrides: Partial<PaymentObligation> = {},
): PaymentObligation {
  return {
    id: 'obligation_1',
    merchantId: 'merchant_1',
    checkoutId: 'checkout_1',
    collectionRail: 'ONLINE',
    purpose: 'FULL_ONLINE',
    amountPaise: 10_000n,
    currency: 'INR',
    status: 'OPEN',
    satisfiedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe('assertAttemptEligible', () => {
  it('accepts only an open unsatisfied online obligation', () => {
    assert.doesNotThrow(() => assertAttemptEligible(obligation()));
  });

  for (const status of ['SATISFIED', 'EXPIRED', 'CANCELLED'] as const) {
    it(`rejects an online obligation whose locked status is ${status}`, () => {
      assert.throws(
        () => assertAttemptEligible(obligation({ status })),
        /OBLIGATION_NOT_ATTEMPT_ELIGIBLE/,
      );
    });
  }

  it('rejects an OPEN obligation carrying a satisfied timestamp', () => {
    assert.throws(
      () => assertAttemptEligible(obligation({ satisfiedAt: new Date(1) })),
      /OBLIGATION_NOT_ATTEMPT_ELIGIBLE/,
    );
  });
});
