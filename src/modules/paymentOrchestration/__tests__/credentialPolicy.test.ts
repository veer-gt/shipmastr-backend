import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideCredentialUse,
  type CredentialOperation,
  type CredentialUseInput,
} from '../credentialPolicy.js';

function baseInput(
  overrides: Partial<CredentialUseInput> = {},
): CredentialUseInput {
  return {
    originalMerchantId: 'merchant_1',
    requestedMerchantId: 'merchant_1',
    originalProvider: 'CASHFREE',
    requestedProvider: 'CASHFREE',
    originalEnvironment: 'TEST',
    requestedEnvironment: 'TEST',
    originalBindingId: 'binding_1',
    requestedBindingId: 'binding_1',
    continuity: 'PROVEN_SAME_ACCOUNT',
    credentialState: 'ACTIVE',
    operation: 'STATUS_QUERY',
    ...overrides,
  };
}

describe('decideCredentialUse', () => {
  it('allows same-account rotation for read-only status query only', () => {
    assert.deepEqual(
      decideCredentialUse(baseInput()),
      { allowed: true, operation: 'STATUS_QUERY' },
    );

    const mutatingOperations: CredentialOperation[] = [
      'CREATE',
      'CHARGE',
      'AUTHORIZE',
      'CAPTURE',
      'CANCEL',
      'REFUND',
      'REPLAY',
    ];

    for (const operation of mutatingOperations) {
      assert.deepEqual(
        decideCredentialUse(baseInput({ operation })),
        {
          allowed: false,
          reason: 'OPERATION_NOT_ALLOWED',
          forceUnknownIfUnresolved: true,
          requireReview: true,
          preserveProviderLock: true,
          securityAlert: true,
        },
      );
    }
  });

  it('fails closed for revoked, disconnected, and unproven continuity states', () => {
    assert.deepEqual(
      decideCredentialUse(baseInput({ credentialState: 'REVOKED' })),
      {
        allowed: false,
        reason: 'CREDENTIAL_NOT_ACTIVE',
        forceUnknownIfUnresolved: true,
        requireReview: true,
        preserveProviderLock: true,
        securityAlert: true,
      },
    );

    assert.deepEqual(
      decideCredentialUse(baseInput({ credentialState: 'DISCONNECTED' })),
      {
        allowed: false,
        reason: 'CREDENTIAL_NOT_ACTIVE',
        forceUnknownIfUnresolved: true,
        requireReview: true,
        preserveProviderLock: true,
        securityAlert: true,
      },
    );

    assert.deepEqual(
      decideCredentialUse(baseInput({ continuity: 'UNPROVEN' })),
      {
        allowed: false,
        reason: 'CONTINUITY_NOT_PROVEN',
        forceUnknownIfUnresolved: true,
        requireReview: true,
        preserveProviderLock: true,
        securityAlert: true,
      },
    );
  });

  it('rejects account, merchant, environment, or provider rebinding with a security alert', () => {
    const rebindingInputs: CredentialUseInput[] = [
      baseInput({ requestedMerchantId: 'merchant_2' }),
      baseInput({ requestedProvider: 'PAYTM' }),
      baseInput({ requestedEnvironment: 'LIVE' }),
      baseInput({ requestedBindingId: 'binding_2' }),
    ];

    for (const input of rebindingInputs) {
      assert.deepEqual(
        decideCredentialUse(input),
        {
          allowed: false,
          reason: 'BINDING_MISMATCH',
          forceUnknownIfUnresolved: true,
          requireReview: true,
          preserveProviderLock: true,
          securityAlert: true,
        },
      );
    }
  });
});
