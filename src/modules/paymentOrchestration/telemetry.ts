import { logger } from '../../lib/logger.js';
import type { PaymentProvider } from './types.js';

export type Pgo1TelemetryType =
  | 'UNRESOLVED_AGE'
  | 'TIMEOUT_TO_UNKNOWN'
  | 'RECONCILIATION_SLA_BREACH'
  | 'POLICY_DISABLED'
  | 'MAPPING_GAP'
  | 'SIGNATURE_FAILURE'
  | 'BINDING_MISMATCH'
  | 'CREDENTIAL_LIFECYCLE_FAILURE'
  | 'AMOUNT_CURRENCY_REFERENCE_MISMATCH'
  | 'INTEGRITY_CONFLICT'
  | 'CONTRADICTORY_EVIDENCE'
  | 'DOUBLE_SUCCESS_DETECTED'
  | 'REFUND_DUE_AGING'
  | 'REFUND_DUE_ESCALATED'
  | 'REDUCER_FAILURE'
  | 'REDUCER_LAG'
  | 'OUTBOX_DUPLICATE'
  | 'OUTBOX_BACKLOG'
  | 'OUTBOX_VALIDATION_FAILURE'
  | 'PROHIBITED_SHADOW_MUTATION';

type TelemetryBase = {
  merchantId: string;
};

type AttemptObligationProviderTelemetry = TelemetryBase & {
  attemptId: string;
  obligationId: string;
  provider: PaymentProvider;
};

type AttemptProviderTelemetry = TelemetryBase & {
  attemptId: string;
  provider: PaymentProvider;
};

type AttemptObligationTelemetry = TelemetryBase & {
  attemptId: string;
  obligationId: string;
};

export type Pgo1TelemetryEvent =
  | (AttemptObligationProviderTelemetry & { type: 'UNRESOLVED_AGE'; reason: string })
  | (AttemptObligationProviderTelemetry & { type: 'TIMEOUT_TO_UNKNOWN'; nativeStatus: string })
  | (AttemptObligationProviderTelemetry & { type: 'RECONCILIATION_SLA_BREACH'; policyVersion: string | null })
  | (TelemetryBase & { type: 'POLICY_DISABLED'; provider: PaymentProvider; policyVersion: string | null; reason: string })
  | (AttemptProviderTelemetry & { type: 'MAPPING_GAP'; mappingVersion: string; nativeStatus: string })
  | (AttemptProviderTelemetry & { type: 'SIGNATURE_FAILURE'; nativeStatus: string; reason: string })
  | (AttemptObligationProviderTelemetry & { type: 'BINDING_MISMATCH'; reason: string })
  | (AttemptProviderTelemetry & { type: 'CREDENTIAL_LIFECYCLE_FAILURE'; reason: string })
  | (AttemptObligationProviderTelemetry & { type: 'AMOUNT_CURRENCY_REFERENCE_MISMATCH'; reason: string })
  | (AttemptObligationProviderTelemetry & { type: 'INTEGRITY_CONFLICT'; reason: string })
  | (AttemptObligationProviderTelemetry & { type: 'CONTRADICTORY_EVIDENCE'; reason: string })
  | (AttemptObligationProviderTelemetry & { type: 'DOUBLE_SUCCESS_DETECTED'; reason: string })
  | (AttemptObligationProviderTelemetry & { type: 'REFUND_DUE_AGING'; reason: string })
  | (AttemptObligationProviderTelemetry & { type: 'REFUND_DUE_ESCALATED'; reason: string })
  | (AttemptObligationTelemetry & { type: 'REDUCER_FAILURE'; reason: string })
  | (AttemptObligationTelemetry & { type: 'REDUCER_LAG'; reason: string })
  | (AttemptObligationTelemetry & { type: 'OUTBOX_DUPLICATE'; reason: string })
  | (AttemptObligationTelemetry & { type: 'OUTBOX_BACKLOG'; reason: string })
  | (AttemptObligationTelemetry & { type: 'OUTBOX_VALIDATION_FAILURE'; reason: string })
  | (AttemptObligationTelemetry & { type: 'PROHIBITED_SHADOW_MUTATION'; reason: string });

type TelemetrySink = {
  warn(payload: { event: SanitizedTelemetryEvent }, message: string): void;
};

type SanitizedTelemetryEvent = {
  type: Pgo1TelemetryType;
  merchantId: string;
  attemptId?: string;
  obligationId?: string;
  provider?: PaymentProvider;
  policyVersion?: string | null;
  mappingVersion?: string;
  nativeStatus?: string;
  reason?: string;
  containsPii: false;
};

type TelemetryRule = {
  required: readonly string[];
  optional: readonly string[];
};

const TELEMETRY_RULES: Record<Pgo1TelemetryType, TelemetryRule> = {
  UNRESOLVED_AGE: rule(['merchantId', 'attemptId', 'obligationId', 'provider', 'reason'], []),
  TIMEOUT_TO_UNKNOWN: rule(['merchantId', 'attemptId', 'obligationId', 'provider', 'nativeStatus'], []),
  RECONCILIATION_SLA_BREACH: rule(['merchantId', 'attemptId', 'obligationId', 'provider', 'policyVersion'], []),
  POLICY_DISABLED: rule(['merchantId', 'provider', 'policyVersion', 'reason'], []),
  MAPPING_GAP: rule(['merchantId', 'attemptId', 'provider', 'mappingVersion', 'nativeStatus'], []),
  SIGNATURE_FAILURE: rule(['merchantId', 'attemptId', 'provider', 'nativeStatus', 'reason'], []),
  BINDING_MISMATCH: rule(['merchantId', 'attemptId', 'obligationId', 'provider', 'reason'], []),
  CREDENTIAL_LIFECYCLE_FAILURE: rule(['merchantId', 'attemptId', 'provider', 'reason'], []),
  AMOUNT_CURRENCY_REFERENCE_MISMATCH: rule(['merchantId', 'attemptId', 'obligationId', 'provider', 'reason'], []),
  INTEGRITY_CONFLICT: rule(['merchantId', 'attemptId', 'obligationId', 'provider', 'reason'], []),
  CONTRADICTORY_EVIDENCE: rule(['merchantId', 'attemptId', 'obligationId', 'provider', 'reason'], []),
  DOUBLE_SUCCESS_DETECTED: rule(['merchantId', 'attemptId', 'obligationId', 'provider', 'reason'], []),
  REFUND_DUE_AGING: rule(['merchantId', 'attemptId', 'obligationId', 'provider', 'reason'], []),
  REFUND_DUE_ESCALATED: rule(['merchantId', 'attemptId', 'obligationId', 'provider', 'reason'], []),
  REDUCER_FAILURE: rule(['merchantId', 'attemptId', 'obligationId', 'reason'], []),
  REDUCER_LAG: rule(['merchantId', 'attemptId', 'obligationId', 'reason'], []),
  OUTBOX_DUPLICATE: rule(['merchantId', 'attemptId', 'obligationId', 'reason'], []),
  OUTBOX_BACKLOG: rule(['merchantId', 'attemptId', 'obligationId', 'reason'], []),
  OUTBOX_VALIDATION_FAILURE: rule(['merchantId', 'attemptId', 'obligationId', 'reason'], []),
  PROHIBITED_SHADOW_MUTATION: rule(['merchantId', 'attemptId', 'obligationId', 'reason'], []),
};

const EMAIL_LIKE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;

export class Pgo1Telemetry {
  constructor(private readonly sink: TelemetrySink = logger) {}

  emit(event: Pgo1TelemetryEvent): void {
    const sanitized = sanitizeEvent(event);
    this.sink.warn({ event: sanitized }, 'pgo1_telemetry');
  }
}

function rule(required: string[], optional: string[]): TelemetryRule {
  return {
    required,
    optional,
  };
}

function sanitizeEvent(event: Pgo1TelemetryEvent): SanitizedTelemetryEvent {
  const unknownFields = listUnknownFields(event);
  if (unknownFields.length > 0) {
    throw new Error(`PROHIBITED_TELEMETRY_FIELD:${unknownFields.join(',')}`);
  }

  const type = assertTelemetryType(event.type);
  const telemetryRule = TELEMETRY_RULES[type];
  assertTelemetryShape(event as Record<string, unknown>, telemetryRule);

  const sanitized: SanitizedTelemetryEvent = {
    type,
    merchantId: validateText(event.merchantId, 'merchantId'),
    containsPii: false,
  };

  if ('attemptId' in event) {
    sanitized.attemptId = validateText(event.attemptId, 'attemptId');
  }
  if ('obligationId' in event) {
    sanitized.obligationId = validateText(event.obligationId, 'obligationId');
  }
  if ('provider' in event) {
    sanitized.provider = validateProvider(event.provider);
  }
  if ('policyVersion' in event) {
    sanitized.policyVersion = validateNullableText(event.policyVersion, 'policyVersion');
  }
  if ('mappingVersion' in event) {
    sanitized.mappingVersion = validateText(event.mappingVersion, 'mappingVersion');
  }
  if ('nativeStatus' in event) {
    sanitized.nativeStatus = validateText(event.nativeStatus, 'nativeStatus');
  }
  if ('reason' in event) {
    sanitized.reason = validateText(event.reason, 'reason');
  }

  return sanitized;
}

function listUnknownFields(event: Pgo1TelemetryEvent) {
  const ruleForType = TELEMETRY_RULES[assertTelemetryType(event.type)];
  const allowed = new Set<string>(['type']);
  for (const key of ruleForType.required) {
    allowed.add(key);
  }
  for (const key of ruleForType.optional) {
    allowed.add(key);
  }

  const unknown: string[] = [];
  for (const key of Object.keys(event)) {
    if (!allowed.has(key)) {
      unknown.push(key);
    }
  }
  return unknown;
}

function assertTelemetryType(type: string): Pgo1TelemetryType {
  if (!(type in TELEMETRY_RULES)) {
    throw new Error('UNKNOWN_PGO1_TELEMETRY_TYPE');
  }
  return type as Pgo1TelemetryType;
}

function assertTelemetryShape(event: Record<string, unknown>, telemetryRule: TelemetryRule) {
  for (const field of telemetryRule.required) {
    if (!(field in event)) {
      throw new Error(`PGO1_TELEMETRY_FIELD_REQUIRED:${field}`);
    }
  }
}

function validateProvider(provider: unknown): PaymentProvider {
  if (provider === 'MOCK' || provider === 'CASHFREE' || provider === 'PAYTM') {
    return provider;
  }
  throw new Error('INVALID_PGO1_PROVIDER');
}

function validateText(value: unknown, field: string) {
  if (typeof value !== 'string') {
    throw new Error(`INVALID_PGO1_TELEMETRY_FIELD:${field}`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(`INVALID_PGO1_TELEMETRY_FIELD:${field}`);
  }
  assertNoPii(trimmed);
  return trimmed;
}

function validateNullableText(value: unknown, field: string) {
  if (value === null) {
    return null;
  }
  return validateText(value, field);
}

function assertNoPii(value: string) {
  if (EMAIL_LIKE.test(value) || containsPhoneLikeValue(value) || containsInstrumentLikeValue(value)) {
    throw new Error('PII_FORBIDDEN_IN_TELEMETRY');
  }
}

function containsPhoneLikeValue(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function containsInstrumentLikeValue(value: string) {
  const digits = value.replace(/[\s-]/g, '');
  return /^\d{13,19}$/.test(digits);
}
