import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchObservation } from '../matching.js';
import type {
  CanonicalObservation,
  CanonicalObservationSource,
  EvidenceAuthority,
  MatchFailureReason,
  MatchInput,
  PaymentProvider,
  SignatureVerification,
} from '../types.js';

function buildInput(
  overrides: {
    observation?: Partial<CanonicalObservation>;
    obligation?: Partial<MatchInput['obligation']>;
    attempt?: Partial<MatchInput['attempt']>;
    returnedIdempotencyKey?: string | null;
  } = {},
): MatchInput {
  const obligation: MatchInput['obligation'] = {
    id: 'obligation_1',
    merchantId: 'merchant_1',
    amountPaise: 10_000n,
    currency: 'INR',
    status: 'OPEN',
    ...overrides.obligation,
  };

  const attempt: MatchInput['attempt'] = {
    id: 'attempt_1',
    obligationId: obligation.id,
    merchantId: obligation.merchantId,
    provider: 'MOCK',
    environment: 'TEST',
    credentialBindingId: 'binding_1',
    providerOrderRef: 'order_1',
    requestIdempotencyKey: 'idem_1',
    adapterVersion: 'adapter_v1',
    mappingVersion: 'mapping_v1',
    ...overrides.attempt,
  };

  const observation: CanonicalObservation = {
    id: 'observation_1',
    attemptId: attempt.id,
    obligationId: obligation.id,
    merchantId: obligation.merchantId,
    provider: attempt.provider,
    environment: attempt.environment,
    credentialBindingId: attempt.credentialBindingId,
    credentialVersionId: 'credential_version_1',
    source: 'MOCK',
    providerEventId: 'event_1',
    providerOrderRef: 'order_1',
    providerTransactionRef: 'txn_1',
    nativeStatus: 'captured',
    nativeReasonCode: null,
    amountPaise: obligation.amountPaise,
    nativeAmountText: '100.00',
    nativeCurrency: obligation.currency,
    rawBodyHash: 'hash_1',
    hashAlgorithm: 'SHA-256',
    signatureVerification: 'NOT_APPLICABLE',
    bindingVerification: 'VERIFIED',
    evidenceAuthority: 'ELIGIBLE',
    mappedOutcome: 'SUCCEEDED',
    adapterVersion: attempt.adapterVersion,
    mappingVersion: attempt.mappingVersion,
    providerApiVersion: 'mock-2026-08-27',
    providerOccurredAt: new Date('2026-08-27T12:00:00.000Z'),
    receivedAt: new Date('2026-08-27T12:00:01.000Z'),
    reductionDisposition: 'ACCEPTED',
    ...overrides.observation,
  };

  const input: MatchInput = {
    observation,
    obligation,
    attempt,
  };

  if (overrides.returnedIdempotencyKey !== undefined) {
    input.returnedIdempotencyKey = overrides.returnedIdempotencyKey;
  }

  return input;
}

describe('matchObservation', () => {
  it('matches an exact success observation', () => {
    assert.deepEqual(matchObservation(buildInput()), { matched: true });
  });

  for (const [name, input, expected] of [
    [
      'merchant mismatch',
      buildInput({ observation: { merchantId: 'merchant_2' } }),
      { matched: false, reason: 'MERCHANT_MISMATCH' },
    ],
    [
      'provider mismatch',
      buildInput({ observation: { provider: 'CASHFREE' } }),
      { matched: false, reason: 'PROVIDER_MISMATCH' },
    ],
    [
      'environment mismatch',
      buildInput({ observation: { environment: 'LIVE' } }),
      { matched: false, reason: 'ENVIRONMENT_MISMATCH' },
    ],
    [
      'credential binding mismatch by identifier',
      buildInput({ observation: { credentialBindingId: 'binding_2' } }),
      { matched: false, reason: 'CREDENTIAL_BINDING_MISMATCH' },
    ],
    [
      'credential binding mismatch by verification state',
      buildInput({ observation: { bindingVerification: 'FAILED' } }),
      { matched: false, reason: 'CREDENTIAL_BINDING_MISMATCH' },
    ],
    [
      'order reference mismatch',
      buildInput({ observation: { providerOrderRef: 'order_2' } }),
      { matched: false, reason: 'ORDER_REFERENCE_MISMATCH' },
    ],
    [
      'missing transaction reference for success',
      buildInput({ observation: { providerTransactionRef: null } }),
      { matched: false, reason: 'MISSING_TRANSACTION_REFERENCE' },
    ],
    [
      'amount mismatch',
      buildInput({ observation: { amountPaise: 10_001n } }),
      { matched: false, reason: 'AMOUNT_MISMATCH' },
    ],
    [
      'currency mismatch',
      buildInput({ observation: { nativeCurrency: 'USD' } }),
      { matched: false, reason: 'CURRENCY_MISMATCH' },
    ],
    [
      'unmapped status',
      buildInput({ observation: { mappedOutcome: 'UNMAPPED' } }),
      { matched: false, reason: 'UNMAPPED_STATUS' },
    ],
    [
      'mapping version mismatch',
      buildInput({ observation: { mappingVersion: 'mapping_v2' } }),
      { matched: false, reason: 'MAPPING_VERSION_MISMATCH' },
    ],
    [
      'internal reference mismatch',
      buildInput({ observation: { attemptId: 'attempt_2' } }),
      { matched: false, reason: 'INTERNAL_REFERENCE_MISMATCH' },
    ],
    [
      'idempotency key mismatch when provider returns one',
      buildInput({ returnedIdempotencyKey: 'idem_2' }),
      { matched: false, reason: 'IDEMPOTENCY_KEY_MISMATCH' },
    ],
    [
      'unbound provider order reference on the attempt',
      buildInput({ attempt: { providerOrderRef: null } }),
      { matched: false, reason: 'ORDER_REFERENCE_MISMATCH' },
    ],
  ] as const satisfies ReadonlyArray<
    readonly [string, MatchInput, { matched: false; reason: MatchFailureReason }]
  >) {
    it(`returns ${expected.reason} for ${name}`, () => {
      assert.deepEqual(matchObservation(input), expected);
    });
  }

  it('treats unknown status as matchable without a transaction reference', () => {
    assert.deepEqual(
      matchObservation(
        buildInput({
          observation: {
            mappedOutcome: 'UNKNOWN',
            providerTransactionRef: null,
            nativeStatus: 'timeout',
          },
        }),
      ),
      { matched: true },
    );
  });

  const providersBySource: Record<CanonicalObservationSource, PaymentProvider> = {
    WEBHOOK: 'CASHFREE',
    STATUS_QUERY: 'CASHFREE',
    PROVIDER_RECORD: 'PAYTM',
    MOCK: 'MOCK',
  };

  for (const source of ['WEBHOOK', 'STATUS_QUERY', 'PROVIDER_RECORD', 'MOCK'] as const) {
    for (const signatureVerification of [
      'VERIFIED',
      'FAILED',
      'NOT_APPLICABLE',
      'UNAVAILABLE',
    ] as const satisfies readonly SignatureVerification[]) {
      for (const evidenceAuthority of [
        'ELIGIBLE',
        'ACTIVATION_GATED',
        'INELIGIBLE',
      ] as const satisfies readonly EvidenceAuthority[]) {
        const provider = providersBySource[source];
        const input = buildInput({
          attempt: { provider },
          observation: {
            source,
            provider,
            signatureVerification,
            evidenceAuthority,
          },
        });

        const signatureAllowed =
          (source === 'WEBHOOK' && signatureVerification === 'VERIFIED') ||
          ((source === 'STATUS_QUERY' || source === 'PROVIDER_RECORD' || source === 'MOCK') &&
            signatureVerification === 'NOT_APPLICABLE');
        const authorityAllowed = evidenceAuthority === 'ELIGIBLE';
        const shouldMatch = signatureAllowed && authorityAllowed;
        const expected = shouldMatch
          ? { matched: true as const }
          : {
              matched: false as const,
              reason: signatureAllowed
                ? ('EVIDENCE_NOT_AUTHORIZED' as const)
                : ('UNAUTHENTICATED' as const),
            };

        it(`enforces ${source} authenticity for signature=${signatureVerification} authority=${evidenceAuthority}`, () => {
          assert.deepEqual(matchObservation(input), expected);
        });
      }
    }
  }
});
