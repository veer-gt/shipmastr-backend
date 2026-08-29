import assert from 'node:assert/strict';
import type {
  MockCreateInput,
  MockExecutableAdapter,
  MockStatusQueryInput,
  ParsedObservationFields,
  RawObservationInput,
} from './providerAdapter.js';

interface EncodedMockObservation {
  schemaVersion: 'mock-observation-v1';
  merchantId: string;
  obligationId: string;
  attemptId: string;
  providerEventId: string;
  providerOrderRef: string;
  providerTransactionRef: string | null;
  amountPaise: string;
  currency: 'INR';
  scenario: MockCreateInput['scenario'];
  nativeStatus: string;
  nativeReasonCode: string | null;
  providerOccurredAt: string;
  bodyVariant: 'CANONICAL' | 'INTEGRITY_CONFLICT';
}

interface ScenarioDefinition {
  mappedOutcome: ParsedObservationFields['mappedOutcome'];
  nativeStatus: string;
  nativeReasonCode: string | null;
  providerTransactionRef(input: MockCreateInput): string | null;
  providerOccurredAt: string;
  bodyVariant: EncodedMockObservation['bodyVariant'];
}

const MOCK_SCHEMA_VERSION = 'mock-observation-v1';
const MOCK_ADAPTER_VERSION = 'mock-adapter-v1';
const MOCK_MAPPING_VERSION = 'mock-mapping-v1';
const MOCK_PROVIDER_API_VERSION = 'mock-api-2026-08-28';

export function mockProviderOrderRef(obligationId: string, attemptId: string) {
  return `mock_order_${obligationId}_${attemptId}`;
}

const SCENARIOS: Record<MockCreateInput['scenario'], ScenarioDefinition> = {
  SUCCESS: {
    mappedOutcome: 'SUCCEEDED',
    nativeStatus: 'captured',
    nativeReasonCode: null,
    providerTransactionRef: (input) => `mock_txn_${input.attemptId}_success`,
    providerOccurredAt: '2026-08-28T00:00:01.000Z',
    bodyVariant: 'CANONICAL',
  },
  TERMINAL_FAILURE: {
    mappedOutcome: 'FAILED_TERMINAL',
    nativeStatus: 'failed',
    nativeReasonCode: null,
    providerTransactionRef: () => null,
    providerOccurredAt: '2026-08-28T00:00:02.000Z',
    bodyVariant: 'CANONICAL',
  },
  TIMEOUT: {
    mappedOutcome: 'UNKNOWN',
    nativeStatus: 'timeout',
    nativeReasonCode: null,
    providerTransactionRef: () => null,
    providerOccurredAt: '2026-08-28T00:00:03.000Z',
    bodyVariant: 'CANONICAL',
  },
  PENDING: {
    mappedOutcome: 'PENDING',
    nativeStatus: 'pending',
    nativeReasonCode: null,
    providerTransactionRef: () => null,
    providerOccurredAt: '2026-08-28T00:00:04.000Z',
    bodyVariant: 'CANONICAL',
  },
  UNKNOWN: {
    mappedOutcome: 'UNKNOWN',
    nativeStatus: 'unknown',
    nativeReasonCode: null,
    providerTransactionRef: () => null,
    providerOccurredAt: '2026-08-28T00:00:05.000Z',
    bodyVariant: 'CANONICAL',
  },
  INTEGRITY_CONFLICT: {
    mappedOutcome: 'SUCCEEDED',
    nativeStatus: 'captured_conflict',
    nativeReasonCode: null,
    providerTransactionRef: (input) => `mock_txn_${input.attemptId}_success`,
    providerOccurredAt: '2026-08-28T00:00:01.000Z',
    bodyVariant: 'INTEGRITY_CONFLICT',
  },
};

export const mockAdapter: MockExecutableAdapter = {
  provider: 'MOCK',
  adapterVersion: MOCK_ADAPTER_VERSION,
  mappingVersion: MOCK_MAPPING_VERSION,
  providerApiVersion: MOCK_PROVIDER_API_VERSION,
  async create(input) {
    return encodeMockObservation(input);
  },
  async queryStatus(input) {
    return encodeMockObservation(statusScenario(input));
  },
  parse(input) {
    return parseMockObservation(input);
  },
};

function statusScenario(input: MockStatusQueryInput): MockCreateInput {
  const base: MockCreateInput = {
    attemptId: input.attemptId,
    obligationId: input.obligationId,
    merchantId: input.merchantId,
    amountPaise: input.amountPaise,
    currency: input.currency,
    scenario: input.scenario,
  };

  if (input.delivery !== undefined) {
    return {
      ...base,
      delivery: input.delivery,
    };
  }

  return base;
}

function encodeMockObservation(input: MockCreateInput): RawObservationInput {
  const payload = encodedPayload(input);
  return {
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
    headers: buildHeaders(input),
    receivedAt: new Date(payload.providerOccurredAt),
  };
}

function buildHeaders(input: MockCreateInput): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-mock-adapter-version': MOCK_ADAPTER_VERSION,
  };

  if (input.delivery !== undefined) {
    headers['x-mock-delivery'] = String(input.delivery);
  }

  return headers;
}

function encodedPayload(input: MockCreateInput): EncodedMockObservation {
  const scenario = SCENARIOS[input.scenario];
  return {
    schemaVersion: MOCK_SCHEMA_VERSION,
    merchantId: input.merchantId,
    obligationId: input.obligationId,
    attemptId: input.attemptId,
    providerEventId: `mock_evt_${input.merchantId}_${input.obligationId}_${input.attemptId}`,
    providerOrderRef: `mock_order_${input.obligationId}_${input.attemptId}`,
    providerTransactionRef: scenario.providerTransactionRef(input),
    amountPaise: input.amountPaise.toString(),
    currency: input.currency,
    scenario: input.scenario,
    nativeStatus: scenario.nativeStatus,
    nativeReasonCode: scenario.nativeReasonCode,
    providerOccurredAt: scenario.providerOccurredAt,
    bodyVariant: scenario.bodyVariant,
  };
}

function parseMockObservation(input: RawObservationInput): ParsedObservationFields {
  const payload = decodePayload(input.rawBody);
  const scenario = SCENARIOS[payload.scenario];

  return {
    provider: 'MOCK',
    environment: 'TEST',
    source: 'MOCK',
    providerEventId: payload.providerEventId,
    providerOrderRef: payload.providerOrderRef,
    providerTransactionRef: payload.providerTransactionRef,
    nativeStatus: payload.nativeStatus,
    nativeReasonCode: payload.nativeReasonCode,
    amountPaise: BigInt(payload.amountPaise),
    nativeAmountText: formatPaise(BigInt(payload.amountPaise)),
    nativeCurrency: payload.currency,
    evidenceAuthority: 'ELIGIBLE',
    mappedOutcome: scenario.mappedOutcome,
    adapterVersion: MOCK_ADAPTER_VERSION,
    mappingVersion: MOCK_MAPPING_VERSION,
    providerApiVersion: MOCK_PROVIDER_API_VERSION,
    providerOccurredAt: new Date(payload.providerOccurredAt),
  };
}

function decodePayload(rawBody: Buffer): EncodedMockObservation {
  const value = JSON.parse(rawBody.toString('utf8')) as Partial<EncodedMockObservation>;

  assert.equal(value.schemaVersion, MOCK_SCHEMA_VERSION);
  assert.equal(typeof value.merchantId, 'string');
  assert.equal(typeof value.obligationId, 'string');
  assert.equal(typeof value.attemptId, 'string');
  assert.equal(typeof value.providerEventId, 'string');
  assert.equal(typeof value.providerOrderRef, 'string');
  assert.equal(typeof value.amountPaise, 'string');
  assert.equal(value.currency, 'INR');
  assert.ok(value.scenario && value.scenario in SCENARIOS);
  assert.equal(typeof value.nativeStatus, 'string');
  assert.ok(value.providerOccurredAt);
  assert.ok(value.bodyVariant === 'CANONICAL' || value.bodyVariant === 'INTEGRITY_CONFLICT');

  return value as EncodedMockObservation;
}

function formatPaise(amountPaise: bigint): string {
  const rupees = amountPaise / 100n;
  const paise = amountPaise % 100n;
  return `${rupees}.${paise.toString().padStart(2, '0')}`;
}
