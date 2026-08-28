import type { PaymentProvider } from './types.js';

export type ShadowValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason: 'PROHIBITED_FIELD' | 'INVALID_SCHEMA' | 'INVALID_MONEY' | 'INVALID_REFERENCE';
    };

type CanonicalFactType = 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED' | 'REFUND_DUE_DETECTED';

type ShadowFact = {
  factId: string;
  schemaVersion: 'pgo1-fact-v1';
  merchantId: string;
  obligationId: string;
  attemptId: string;
  triggeringObservationId: string;
  factType: CanonicalFactType;
  amountPaise: bigint;
  currency: 'INR';
  provider: PaymentProvider;
  providerReferenceId: string;
  dedupeKey: string;
  reducerVersion: string;
  adapterVersion: string;
  mappingVersion: string;
  createdAt: string;
};

const ALLOWED_FIELDS = new Set<keyof ShadowFact>([
  'factId',
  'schemaVersion',
  'merchantId',
  'obligationId',
  'attemptId',
  'triggeringObservationId',
  'factType',
  'amountPaise',
  'currency',
  'provider',
  'providerReferenceId',
  'dedupeKey',
  'reducerVersion',
  'adapterVersion',
  'mappingVersion',
  'createdAt',
]);

const ALLOWED_FACT_TYPES = new Set<CanonicalFactType>([
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'REFUND_DUE_DETECTED',
]);

const ALLOWED_PROVIDERS = new Set<PaymentProvider>(['MOCK', 'CASHFREE', 'PAYTM']);

export function validateShadowFact(fact: unknown): ShadowValidationResult {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
    return { valid: false, reason: 'INVALID_REFERENCE' };
  }

  const keys = Object.keys(fact);
  for (const key of keys) {
    if (!ALLOWED_FIELDS.has(key as keyof ShadowFact)) {
      return { valid: false, reason: 'PROHIBITED_FIELD' };
    }
  }

  const candidate = fact as Partial<ShadowFact>;

  if (candidate.schemaVersion !== 'pgo1-fact-v1') {
    return { valid: false, reason: 'INVALID_SCHEMA' };
  }

  if (candidate.currency !== 'INR' || typeof candidate.amountPaise !== 'bigint' || candidate.amountPaise < 0n) {
    return { valid: false, reason: 'INVALID_MONEY' };
  }

  if (!ALLOWED_FACT_TYPES.has(candidate.factType as CanonicalFactType)) {
    return { valid: false, reason: 'INVALID_REFERENCE' };
  }

  if (!ALLOWED_PROVIDERS.has(candidate.provider as PaymentProvider)) {
    return { valid: false, reason: 'INVALID_REFERENCE' };
  }

  for (const value of [
    candidate.factId,
    candidate.merchantId,
    candidate.obligationId,
    candidate.attemptId,
    candidate.triggeringObservationId,
    candidate.providerReferenceId,
    candidate.dedupeKey,
    candidate.reducerVersion,
    candidate.adapterVersion,
    candidate.mappingVersion,
    candidate.createdAt,
  ]) {
    if (typeof value !== 'string' || value.trim() === '') {
      return { valid: false, reason: 'INVALID_REFERENCE' };
    }
  }

  if (typeof candidate.createdAt !== 'string' || Number.isNaN(Date.parse(candidate.createdAt))) {
    return { valid: false, reason: 'INVALID_REFERENCE' };
  }

  return { valid: true };
}
