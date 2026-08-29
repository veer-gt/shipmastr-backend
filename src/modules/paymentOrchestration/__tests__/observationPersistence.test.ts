import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  providerEventIdentity,
  providerObservationRowToCanonical,
} from '../observationService.js';

function persistedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'observation_1', attemptId: 'attempt_1', obligationId: 'obligation_1', merchantId: 'merchant_1',
    provider: 'MOCK', environment: 'TEST', credentialBindingId: 'binding_1',
    credentialVersionId: 'credential_version_1', source: 'MOCK', providerEventId: 'event_1',
    providerOrderRef: 'order_1', providerTransactionRef: 'txn_1', nativeStatus: 'captured',
    nativeReasonCode: null, nativeAmountText: '100.00', nativeCurrency: 'INR', amountPaise: 10_000n,
    rawBodyHash: 'hash_1', hashAlgorithm: 'SHA-256', signatureVerification: 'NOT_APPLICABLE',
    bindingVerification: 'VERIFIED', evidenceAuthority: 'ELIGIBLE', mappedOutcome: 'SUCCEEDED',
    adapterVersion: 'adapter-v1', mappingVersion: 'mapping-v1', providerApiVersion: 'mock-api-v1',
    providerOccurredAt: new Date(0), receivedAt: new Date(1), reductionDisposition: 'ACCEPTED',
    observationDedupeKey: 'dedupe_1', createdAt: new Date(2),
    ...overrides,
  };
}

describe('persisted provider observation loading', () => {
  it('reloads the canonical mapped outcome and provider API version verbatim', () => {
    const loaded = providerObservationRowToCanonical(persistedRow());
    assert.equal(loaded.mappedOutcome, 'SUCCEEDED');
    assert.equal(loaded.providerApiVersion, 'mock-api-v1');
    assert.equal(loaded.reductionDisposition, 'ACCEPTED');
  });

  for (const [field, value, error] of [
    ['hashAlgorithm', 'SHA-1', 'INVALID_PERSISTED_HASH_ALGORITHM'],
    ['signatureVerification', 'TRUSTED_BY_DEFAULT', 'INVALID_PERSISTED_SIGNATURE_VERIFICATION'],
    ['bindingVerification', 'UNVERIFIED', 'INVALID_PERSISTED_BINDING_VERIFICATION'],
    ['evidenceAuthority', 'AUTHORIZED_BY_DEFAULT', 'INVALID_PERSISTED_EVIDENCE_AUTHORITY'],
    ['mappedOutcome', 'CAPTUREDISH', 'INVALID_PERSISTED_MAPPED_OUTCOME'],
    ['providerApiVersion', '   ', 'INVALID_PERSISTED_PROVIDER_API_VERSION'],
  ] as const) {
    it(`fails closed for unknown persisted ${field}`, () => {
      assert.throws(() => providerObservationRowToCanonical(persistedRow({ [field]: value })), new RegExp(error));
    });
  }

  it('scopes provider event identity by provider, environment, and attempt', () => {
    const base = persistedRow();
    const identity = providerEventIdentity(base as never);
    assert.notEqual(providerEventIdentity({ ...base, provider: 'CASHFREE' } as never), identity);
    assert.notEqual(providerEventIdentity({ ...base, environment: 'LIVE' } as never), identity);
    assert.notEqual(providerEventIdentity({ ...base, attemptId: 'attempt_2' } as never), identity);
  });
});
