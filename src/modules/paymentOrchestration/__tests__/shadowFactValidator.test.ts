import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as shadowFactValidatorExports from '../shadowFactValidator.js';
import { validateShadowFact } from '../shadowFactValidator.js';
import { PGO1_MAX_BIGINT_PAISE } from '../money.js';

function validFact() {
  return {
    factId: 'fact_1',
    schemaVersion: 'pgo1-fact-v1',
    merchantId: 'merchant_1',
    obligationId: 'obligation_1',
    attemptId: 'attempt_1',
    triggeringObservationId: 'observation_1',
    factType: 'REFUND_DUE_DETECTED',
    amountPaise: 10_000n,
    currency: 'INR',
    provider: 'MOCK',
    providerReferenceId: 'txn_1',
    dedupeKey: 'dedupe_1',
    reducerVersion: 'pgo1-reducer-v1',
    adapterVersion: 'mock-adapter-v1',
    mappingVersion: 'mock-mapping-v1',
    createdAt: '2026-08-28T12:00:00.000Z',
  };
}

function persistedOutboxFact() {
  return {
    id: 'fact_outbox_1',
    schemaVersion: 'pgo1-fact-v1',
    merchantId: 'merchant_1',
    obligationId: 'obligation_1',
    attemptId: 'attempt_1',
    triggeringObservationId: 'observation_1',
    factType: 'REFUND_DUE_DETECTED',
    amountPaise: 10_000n,
    currency: 'INR',
    provider: 'MOCK',
    providerReferenceId: 'txn_1',
    dedupeKey: 'dedupe_1',
    reducerVersion: 'pgo1-reducer-v1',
    adapterVersion: 'mock-adapter-v1',
    mappingVersion: 'mock-mapping-v1',
    createdAt: new Date('2026-08-28T12:00:00.000Z'),
  };
}

describe('validateShadowFact', () => {
  it('accepts only the normalized allowlist', () => {
    assert.deepEqual(validateShadowFact(validFact()), { valid: true });
    assert.deepEqual(validateShadowFact({ ...validFact(), rawBody: '{}' } as never), {
      valid: false,
      reason: 'PROHIBITED_FIELD',
    });
  });

  it('accepts a real Task 5 outbox row through the compatible validation seam', () => {
    assert.deepEqual(validateShadowFact(persistedOutboxFact() as never), { valid: true });
  });

  it('never receives journal, wallet, settlement, payout, refund, or custody writers', () => {
    assert.equal(validateShadowFact.length, 1);
    assert.deepEqual(Object.keys(shadowFactValidatorExports).sort(), ['validateShadowFact']);
  });

  it('rejects invalid schema and non-INR money', () => {
    assert.deepEqual(validateShadowFact({ ...validFact(), schemaVersion: 'pgo1.refund-due.v1' } as never), {
      valid: false,
      reason: 'INVALID_SCHEMA',
    });
    assert.deepEqual(validateShadowFact({ ...validFact(), currency: 'USD' } as never), {
      valid: false,
      reason: 'INVALID_MONEY',
    });
    assert.deepEqual(validateShadowFact({ ...validFact(), amountPaise: 0n } as never), {
      valid: false,
      reason: 'INVALID_MONEY',
    });
    assert.deepEqual(
      validateShadowFact({ ...validFact(), amountPaise: PGO1_MAX_BIGINT_PAISE + 1n } as never),
      {
        valid: false,
        reason: 'INVALID_MONEY',
      },
    );
  });

  it('rejects invalid references and unrecognized fields', () => {
    assert.deepEqual(validateShadowFact({ ...validFact(), factId: '' } as never), {
      valid: false,
      reason: 'INVALID_REFERENCE',
    });
    assert.deepEqual(validateShadowFact({ ...validFact(), note: 'merchant said it is done' } as never), {
      valid: false,
      reason: 'PROHIBITED_FIELD',
    });
  });
});
