import type { PaymentProvider } from './types.js';
import { PGO1_MAX_BIGINT_PAISE } from './money.js';

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

type PersistedOutboxShadowFact = Omit<ShadowFact, 'factId' | 'createdAt'> & {
  id: string;
  createdAt: Date;
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
const PGO1_MIN_BIGINT_PAISE = 1n;

export function validateShadowFact(fact: unknown): ShadowValidationResult {
  const normalized = normalizeShadowFactCandidate(fact);
  if (normalized.kind === 'PROHIBITED_FIELD') {
    return { valid: false, reason: 'PROHIBITED_FIELD' };
  }
  if (normalized.kind === 'INVALID_REFERENCE') {
    return { valid: false, reason: 'INVALID_REFERENCE' };
  }
  const candidate = normalized.fact;

  if (candidate.schemaVersion !== 'pgo1-fact-v1') {
    return { valid: false, reason: 'INVALID_SCHEMA' };
  }

  if (
    candidate.currency !== 'INR' ||
    typeof candidate.amountPaise !== 'bigint' ||
    candidate.amountPaise < PGO1_MIN_BIGINT_PAISE ||
    candidate.amountPaise > PGO1_MAX_BIGINT_PAISE
  ) {
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

function normalizeShadowFactCandidate(fact: unknown):
  | { kind: 'VALID'; fact: ShadowFact }
  | { kind: 'PROHIBITED_FIELD' }
  | { kind: 'INVALID_REFERENCE' } {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
    return { kind: 'INVALID_REFERENCE' };
  }

  if (hasExactKeys(fact, ALLOWED_FIELDS)) {
    return { kind: 'VALID', fact: fact as ShadowFact };
  }

  const outboxKeys = new Set<string>([...ALLOWED_FIELDS].filter((field) => field !== 'factId'));
  outboxKeys.add('id');

  const keys = Object.keys(fact);
  const unionKeys = new Set<string>([...ALLOWED_FIELDS, ...outboxKeys]);
  if (keys.some((key) => !unionKeys.has(key))) {
    return { kind: 'PROHIBITED_FIELD' };
  }

  if (!hasExactKeys(fact, outboxKeys)) {
    return { kind: 'INVALID_REFERENCE' };
  }

  const outboxFact = fact as PersistedOutboxShadowFact;
  if (!(outboxFact.createdAt instanceof Date) || Number.isNaN(outboxFact.createdAt.getTime())) {
    return { kind: 'INVALID_REFERENCE' };
  }

  return {
    kind: 'VALID',
    fact: {
      factId: outboxFact.id,
      schemaVersion: outboxFact.schemaVersion,
      merchantId: outboxFact.merchantId,
      obligationId: outboxFact.obligationId,
      attemptId: outboxFact.attemptId,
      triggeringObservationId: outboxFact.triggeringObservationId,
      factType: outboxFact.factType,
      amountPaise: outboxFact.amountPaise,
      currency: outboxFact.currency,
      provider: outboxFact.provider,
      providerReferenceId: outboxFact.providerReferenceId,
      dedupeKey: outboxFact.dedupeKey,
      reducerVersion: outboxFact.reducerVersion,
      adapterVersion: outboxFact.adapterVersion,
      mappingVersion: outboxFact.mappingVersion,
      createdAt: outboxFact.createdAt.toISOString(),
    },
  };
}

function hasExactKeys(value: object, allowed: ReadonlySet<string>) {
  const keys = Object.keys(value);
  if (keys.length !== allowed.size) {
    return false;
  }

  return keys.every((key) => allowed.has(key));
}
