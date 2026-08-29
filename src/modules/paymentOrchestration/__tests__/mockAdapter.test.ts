import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { mockAdapter, mockProviderOrderRef } from '../adapters/mockAdapter.js';
import type { MockCreateInput, ParsedObservationFields } from '../adapters/providerAdapter.js';

function mockInput(
  overrides: Partial<MockCreateInput> = {},
): MockCreateInput {
  return {
    attemptId: 'attempt_1',
    obligationId: 'obligation_1',
    merchantId: 'merchant_1',
    amountPaise: 10_000n,
    currency: 'INR',
    scenario: 'SUCCESS',
    ...overrides,
  };
}

function expectedCandidate(scenario: MockCreateInput['scenario']): ParsedObservationFields {
  const base = {
    provider: 'MOCK' as const,
    environment: 'TEST' as const,
    source: 'MOCK' as const,
    providerEventId: 'mock_evt_merchant_1_obligation_1_attempt_1',
    providerOrderRef: 'mock_order_obligation_1_attempt_1',
    providerTransactionRef: null,
    nativeReasonCode: null,
    amountPaise: 10_000n,
    nativeAmountText: '100.00',
    nativeCurrency: 'INR',
    evidenceAuthority: 'ELIGIBLE' as const,
    adapterVersion: 'mock-adapter-v1',
    mappingVersion: 'mock-mapping-v1',
    providerApiVersion: 'mock-api-2026-08-28',
  };

  switch (scenario) {
    case 'SUCCESS':
      return {
        ...base,
        providerTransactionRef: 'mock_txn_attempt_1_success',
        nativeStatus: 'captured',
        mappedOutcome: 'SUCCEEDED',
        providerOccurredAt: new Date('2026-08-28T00:00:01.000Z'),
      };
    case 'TERMINAL_FAILURE':
      return {
        ...base,
        nativeStatus: 'failed',
        mappedOutcome: 'FAILED_TERMINAL',
        providerOccurredAt: new Date('2026-08-28T00:00:02.000Z'),
      };
    case 'TIMEOUT':
      return {
        ...base,
        nativeStatus: 'timeout',
        mappedOutcome: 'UNKNOWN',
        providerOccurredAt: new Date('2026-08-28T00:00:03.000Z'),
      };
    case 'PENDING':
      return {
        ...base,
        nativeStatus: 'pending',
        mappedOutcome: 'PENDING',
        providerOccurredAt: new Date('2026-08-28T00:00:04.000Z'),
      };
    case 'UNKNOWN':
      return {
        ...base,
        nativeStatus: 'unknown',
        mappedOutcome: 'UNKNOWN',
        providerOccurredAt: new Date('2026-08-28T00:00:05.000Z'),
      };
    case 'INTEGRITY_CONFLICT':
      return {
        ...base,
        providerTransactionRef: 'mock_txn_attempt_1_success',
        nativeStatus: 'captured_conflict',
        mappedOutcome: 'SUCCEEDED',
        providerOccurredAt: new Date('2026-08-28T00:00:01.000Z'),
      };
  }
}

describe('mockAdapter', () => {
  it('derives the production-seam provider binding from persisted obligation and attempt ids', () => {
    assert.equal(
      mockProviderOrderRef('obligation_1', 'attempt_1'),
      'mock_order_obligation_1_attempt_1',
    );
  });
  for (const scenario of [
    'SUCCESS',
    'TERMINAL_FAILURE',
    'TIMEOUT',
    'PENDING',
    'UNKNOWN',
  ] as const) {
    it(`emits deterministic ${scenario} evidence`, async () => {
      const raw = await mockAdapter.create(mockInput({ scenario }));
      assert.deepEqual(mockAdapter.parse(raw), expectedCandidate(scenario));
    });
  }

  it('uses exact deterministic event IDs and hashes on redelivery', async () => {
    const first = await mockAdapter.create(mockInput({ scenario: 'SUCCESS', delivery: 1 }));
    const replay = await mockAdapter.create(mockInput({ scenario: 'SUCCESS', delivery: 2 }));

    assert.equal(mockAdapter.parse(first).providerEventId, mockAdapter.parse(replay).providerEventId);
    assert.equal(
      createHash('sha256').update(first.rawBody).digest('hex'),
      createHash('sha256').update(replay.rawBody).digest('hex'),
    );
  });

  it('can produce same event ID with a different body for integrity tests', async () => {
    const firstRaw = await mockAdapter.create(mockInput({ scenario: 'SUCCESS' }));
    const alteredRaw = await mockAdapter.create(mockInput({ scenario: 'INTEGRITY_CONFLICT' }));

    assert.equal(mockAdapter.parse(alteredRaw).providerEventId, mockAdapter.parse(firstRaw).providerEventId);
    assert.notEqual(
      createHash('sha256').update(alteredRaw.rawBody).digest('hex'),
      createHash('sha256').update(firstRaw.rawBody).digest('hex'),
    );
  });

  it('derives deterministic query evidence without widening provider authority', async () => {
    const raw = await mockAdapter.queryStatus({
      ...mockInput({ scenario: 'PENDING' }),
      querySequence: 2,
    });

    assert.deepEqual(mockAdapter.parse(raw), expectedCandidate('PENDING'));
  });
});
