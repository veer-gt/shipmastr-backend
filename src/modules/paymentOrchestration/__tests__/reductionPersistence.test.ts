import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildFactInserts,
  normalizedCaptureKey,
} from '../reductionPersistence.js';
import type {
  CanonicalObservation,
  ReductionPersistenceContext,
  ReductionPlan,
} from '../types.js';

function observation(overrides: Partial<CanonicalObservation> = {}): CanonicalObservation {
  return {
    id: 'source_observation',
    attemptId: 'source_attempt',
    obligationId: 'obligation_1',
    merchantId: 'merchant_1',
    provider: 'MOCK',
    environment: 'TEST',
    credentialBindingId: 'binding_1',
    credentialVersionId: 'credential_version_1',
    source: 'MOCK',
    providerEventId: 'event_1',
    providerOrderRef: 'order_1',
    providerTransactionRef: 'txn_1',
    nativeStatus: 'captured',
    nativeReasonCode: null,
    amountPaise: 10_000n,
    nativeAmountText: '100.00',
    nativeCurrency: 'INR',
    rawBodyHash: 'hash_1',
    hashAlgorithm: 'SHA-256',
    signatureVerification: 'NOT_APPLICABLE',
    bindingVerification: 'VERIFIED',
    evidenceAuthority: 'ELIGIBLE',
    mappedOutcome: 'SUCCEEDED',
    adapterVersion: 'adapter_source',
    mappingVersion: 'mapping_source',
    providerApiVersion: 'mock-v1',
    providerOccurredAt: new Date('2026-08-27T12:00:00.000Z'),
    receivedAt: new Date('2026-08-27T12:00:01.000Z'),
    reductionDisposition: 'SUCCEEDED',
    ...overrides,
  };
}

describe('reduction persistence identities', () => {
  it('uses the exact frozen normalized capture key', () => {
    assert.equal(
      normalizedCaptureKey('merchant_1', 'obligation_1', 'MOCK', 'txn_1'),
      'merchant_1:obligation_1:MOCK:txn_1',
    );
  });

  it('binds a normalized fact to its source observation, not the later trigger', () => {
    const source = observation();
    const laterTrigger = observation({
      id: 'later_trigger',
      attemptId: 'later_attempt',
      providerEventId: 'event_later',
      providerTransactionRef: null,
      adapterVersion: 'adapter_later',
      mappingVersion: 'mapping_later',
      mappedOutcome: 'FAILED_TERMINAL',
    });
    const context = {
      obligation: {
        id: 'obligation_1', merchantId: 'merchant_1', amountPaise: 10_000n,
        currency: 'INR', status: 'SATISFIED', collectionRail: 'ONLINE', satisfiedAt: new Date(0),
      },
      attempts: [],
      targetAttempt: { id: 'later_attempt', provider: 'MOCK' },
      observations: [source, laterTrigger],
      triggeringObservation: laterTrigger,
    } as unknown as ReductionPersistenceContext;
    const plan = {
      factTypes: ['PAYMENT_SUCCEEDED'],
      factEmissions: [{
        factType: 'PAYMENT_SUCCEEDED',
        sourceAttemptId: 'source_attempt',
        sourceObservationId: 'source_observation',
        provider: 'MOCK',
        providerReferenceId: 'txn_1',
      }],
      refundDue: [],
    } as unknown as ReductionPlan;

    const rows = buildFactInserts(context, plan);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.attemptId, 'source_attempt');
    assert.equal(rows[0]!.triggeringObservationId, 'source_observation');
    assert.equal(rows[0]!.adapterVersion, 'adapter_source');
    assert.equal(rows[0]!.mappingVersion, 'mapping_source');
  });

  it('uses the refund capture identity as the refund fact dedupe key', () => {
    const source = observation();
    const context = {
      obligation: {
        id: 'obligation_1', merchantId: 'merchant_1', amountPaise: 10_000n,
        currency: 'INR', status: 'SATISFIED', collectionRail: 'ONLINE', satisfiedAt: new Date(0),
      },
      attempts: [],
      targetAttempt: { id: 'target_attempt', provider: 'MOCK' },
      observations: [source],
      triggeringObservation: source,
    } as unknown as ReductionPersistenceContext;
    const captureKey = normalizedCaptureKey('merchant_1', 'obligation_1', 'MOCK', 'txn_1');
    const plan = {
      factTypes: ['REFUND_DUE_DETECTED'],
      factEmissions: [{
        factType: 'REFUND_DUE_DETECTED',
        sourceAttemptId: 'source_attempt',
        sourceObservationId: 'source_observation',
        provider: 'MOCK',
        providerReferenceId: 'txn_1',
      }],
      refundDue: [{
        captureKey,
        providerTransactionRef: 'txn_1',
        reason: 'SURPLUS_DOUBLE_SUCCESS',
        sourceAttemptId: 'source_attempt',
        sourceObservationId: 'source_observation',
        provider: 'MOCK',
      }],
    } as unknown as ReductionPlan;

    const rows = buildFactInserts(context, plan);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.providerReferenceId, 'txn_1');
    assert.equal(rows[0]!.dedupeKey, captureKey);
  });
});
