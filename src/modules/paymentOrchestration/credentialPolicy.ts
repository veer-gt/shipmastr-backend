import type { PaymentProvider, ProviderEnvironment } from './types.js';

export type CredentialOperation =
  | 'STATUS_QUERY'
  | 'CREATE'
  | 'CHARGE'
  | 'AUTHORIZE'
  | 'CAPTURE'
  | 'CANCEL'
  | 'REFUND'
  | 'REPLAY';

export interface CredentialUseInput {
  originalMerchantId: string;
  requestedMerchantId: string;
  originalProvider: PaymentProvider;
  requestedProvider: PaymentProvider;
  originalEnvironment: ProviderEnvironment;
  requestedEnvironment: ProviderEnvironment;
  originalBindingId: string;
  requestedBindingId: string;
  continuity: 'PROVEN_SAME_ACCOUNT' | 'UNPROVEN';
  credentialState: 'ACTIVE' | 'REVOKED' | 'DISCONNECTED';
  operation: CredentialOperation;
}

export type CredentialUseDecision =
  | { allowed: true; operation: 'STATUS_QUERY' }
  | {
      allowed: false;
      reason: string;
      forceUnknownIfUnresolved: true;
      requireReview: true;
      preserveProviderLock: true;
      securityAlert: boolean;
    };

export function decideCredentialUse(
  input: CredentialUseInput,
): CredentialUseDecision {
  if (
    input.originalMerchantId !== input.requestedMerchantId
    || input.originalProvider !== input.requestedProvider
    || input.originalEnvironment !== input.requestedEnvironment
    || input.originalBindingId !== input.requestedBindingId
  ) {
    return blocked('BINDING_MISMATCH', true);
  }

  if (input.continuity !== 'PROVEN_SAME_ACCOUNT') {
    return blocked('CONTINUITY_NOT_PROVEN', false);
  }

  if (input.credentialState !== 'ACTIVE') {
    return blocked('CREDENTIAL_NOT_ACTIVE', false);
  }

  if (input.operation !== 'STATUS_QUERY') {
    return blocked('OPERATION_NOT_ALLOWED', false);
  }

  return {
    allowed: true,
    operation: 'STATUS_QUERY',
  };
}

function blocked(
  reason: string,
  securityAlert: boolean,
): Extract<CredentialUseDecision, { allowed: false }> {
  return {
    allowed: false,
    reason,
    forceUnknownIfUnresolved: true,
    requireReview: true,
    preserveProviderLock: true,
    securityAlert,
  };
}
