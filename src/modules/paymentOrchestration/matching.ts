import type {
  CanonicalObservation,
  MatchFailureReason,
  MatchInput,
  MatchResult,
} from './types.js';

export function matchObservation(input: MatchInput): MatchResult {
  const { observation, obligation, attempt, returnedIdempotencyKey } = input;

  if (observation.merchantId !== obligation.merchantId || observation.merchantId !== attempt.merchantId) {
    return nonMatch('MERCHANT_MISMATCH');
  }

  if (observation.provider !== attempt.provider) {
    return nonMatch('PROVIDER_MISMATCH');
  }

  if (observation.environment !== attempt.environment) {
    return nonMatch('ENVIRONMENT_MISMATCH');
  }

  if (
    observation.credentialBindingId !== attempt.credentialBindingId ||
    observation.bindingVerification !== 'VERIFIED'
  ) {
    return nonMatch('CREDENTIAL_BINDING_MISMATCH');
  }

  const authenticationFailure = classifyAuthenticationFailure(observation);
  if (authenticationFailure) {
    return nonMatch(authenticationFailure);
  }

  if (attempt.providerOrderRef === null || observation.providerOrderRef !== attempt.providerOrderRef) {
    return nonMatch('ORDER_REFERENCE_MISMATCH');
  }

  if (
    observation.mappedOutcome === 'SUCCEEDED' &&
    (observation.providerTransactionRef === null || observation.providerTransactionRef === '')
  ) {
    return nonMatch('MISSING_TRANSACTION_REFERENCE');
  }

  if (observation.amountPaise !== obligation.amountPaise) {
    return nonMatch('AMOUNT_MISMATCH');
  }

  if (observation.nativeCurrency !== obligation.currency) {
    return nonMatch('CURRENCY_MISMATCH');
  }

  if (observation.mappedOutcome === 'UNMAPPED') {
    return nonMatch('UNMAPPED_STATUS');
  }

  if (observation.mappingVersion !== attempt.mappingVersion) {
    return nonMatch('MAPPING_VERSION_MISMATCH');
  }

  if (
    observation.attemptId !== attempt.id ||
    observation.obligationId !== obligation.id ||
    attempt.obligationId !== obligation.id
  ) {
    return nonMatch('INTERNAL_REFERENCE_MISMATCH');
  }

  if (
    returnedIdempotencyKey !== undefined &&
    returnedIdempotencyKey !== null &&
    returnedIdempotencyKey !== attempt.requestIdempotencyKey
  ) {
    return nonMatch('IDEMPOTENCY_KEY_MISMATCH');
  }

  return { matched: true };
}

function classifyAuthenticationFailure(
  observation: CanonicalObservation,
): Extract<MatchFailureReason, 'UNAUTHENTICATED' | 'EVIDENCE_NOT_AUTHORIZED'> | null {
  switch (observation.source) {
    case 'WEBHOOK':
      if (observation.signatureVerification !== 'VERIFIED') {
        return 'UNAUTHENTICATED';
      }
      break;
    case 'STATUS_QUERY':
    case 'PROVIDER_RECORD':
      if (observation.signatureVerification !== 'NOT_APPLICABLE') {
        return 'UNAUTHENTICATED';
      }
      break;
    case 'MOCK':
      if (
        observation.signatureVerification !== 'NOT_APPLICABLE' ||
        observation.provider !== 'MOCK'
      ) {
        return 'UNAUTHENTICATED';
      }
      break;
  }

  if (observation.evidenceAuthority !== 'ELIGIBLE') {
    return 'EVIDENCE_NOT_AUTHORIZED';
  }

  return null;
}

function nonMatch(reason: MatchFailureReason): MatchResult {
  return { matched: false, reason };
}
