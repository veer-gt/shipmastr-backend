import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveObservationInterpretation } from '../interpretation.js';
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
});
