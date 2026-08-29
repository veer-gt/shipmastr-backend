import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appendDerivedInterpretation, deriveObservationInterpretation } from '../interpretation.js';
import type { Prisma } from '@prisma/client';
import type { CanonicalObservation } from '../types.js';

describe('deriveObservationInterpretation', () => {
  it('creates a frozen derived interpretation without rewriting original observation fields', () => {
    const original = {
      id: 'observation_original_1',
      mappingVersion: 'cashfree-map-old',
      nativeStatus: 'SUCCESS',
      adapterVersion: 'cashfree-adapter-old',
      reductionDisposition: 'UNREDUCED',
    } satisfies Pick<
      CanonicalObservation,
      'id' | 'mappingVersion' | 'nativeStatus' | 'adapterVersion' | 'reductionDisposition'
    >;
    const originalSnapshot = { ...original };
    const derivedAt = new Date('2026-08-28T06:00:00.000Z');

    const derived = deriveObservationInterpretation({
      original,
      derivedAdapterVersion: 'cashfree-contract-fixture-v1',
      derivedMappingVersion: 'cashfree-fixture-map-v1',
      derivedAt,
      map(nativeStatus) {
        return nativeStatus === 'SUCCESS' ? 'SUCCEEDED' : 'UNMAPPED';
      },
    });

    assert.equal(Object.isFrozen(derived), true);
    assert.deepEqual(derived, {
      originalObservationId: 'observation_original_1',
      originalMappingVersion: 'cashfree-map-old',
      derivedAdapterVersion: 'cashfree-contract-fixture-v1',
      derivedMappingVersion: 'cashfree-fixture-map-v1',
      derivedOutcome: 'SUCCEEDED',
      derivedAt,
    });
    assert.deepEqual(original, originalSnapshot);
  });

  it('persists the original mapping version, derived outcome, and derivation time', async () => {
    let create: Record<string, unknown> | undefined;
    const tx = {
      providerObservationInterpretation: {
        upsert(input: { create: Record<string, unknown> }) {
          create = input.create;
          return Promise.resolve(input.create);
        },
      },
    } as unknown as Prisma.TransactionClient;
    const derivedAt = new Date('2026-08-28T06:00:00.000Z');

    await appendDerivedInterpretation(tx, {
      original: {
        id: 'observation_original_1', merchantId: 'merchant_1', obligationId: 'obligation_1',
        attemptId: 'attempt_1', mappingVersion: 'cashfree-map-old', nativeStatus: 'SUCCESS',
      },
      derivedAdapterVersion: 'cashfree-adapter-new',
      derivedMappingVersion: 'cashfree-map-new',
      derivedAt,
      map: () => 'SUCCEEDED',
    });

    assert.deepEqual(create, {
      originalObservationId: 'observation_original_1',
      originalMappingVersion: 'cashfree-map-old',
      merchantId: 'merchant_1',
      obligationId: 'obligation_1',
      attemptId: 'attempt_1',
      derivedAdapterVersion: 'cashfree-adapter-new',
      derivedMappingVersion: 'cashfree-map-new',
      derivedOutcome: 'SUCCEEDED',
      derivedAt,
    });
  });
});
