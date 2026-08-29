import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseInrPaise } from '../money.js';
import type { ObservationParser, ParsedObservationFields, RawObservationInput } from './providerAdapter.js';

export interface CashfreeSignatureInput {
  rawBody: Buffer;
  timestamp: string;
  signature: string;
  secret: string;
}

const CASHFREE_ADAPTER_VERSION = 'cashfree-contract-fixture-v1';
const CASHFREE_MAPPING_VERSION = 'cashfree-fixture-map-v1';
const CASHFREE_PROVIDER_API_VERSION = 'cashfree-webhook-contract-2026-08-28';

const failureStatuses = new Set([
  'NOT_ATTEMPTED',
  'FAILED',
  'USER_DROPPED',
  'VOID',
  'CANCELLED',
]);

interface CashfreePayload {
  event_time?: unknown;
  data?: {
    order?: {
      order_id?: unknown;
      order_currency?: unknown;
    };
    payment?: {
      cf_payment_id?: unknown;
      payment_status?: unknown;
      payment_amount?: unknown;
      payment_currency?: unknown;
      payment_error_code?: unknown;
      payment_time?: unknown;
    };
  };
}

export const cashfreeContractParser: ObservationParser = {
  provider: 'CASHFREE',
  adapterVersion: CASHFREE_ADAPTER_VERSION,
  mappingVersion: CASHFREE_MAPPING_VERSION,
  providerApiVersion: CASHFREE_PROVIDER_API_VERSION,
  parse(input) {
    return parseCashfreeObservation(input);
  },
};

export function verifyCashfreeSignature(input: CashfreeSignatureInput): boolean {
  const expected = createHmac('sha256', input.secret)
    .update(input.timestamp, 'utf8')
    .update(input.rawBody)
    .digest();
  const received = Buffer.from(input.signature, 'base64');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function parseCashfreeObservation(input: RawObservationInput): ParsedObservationFields {
  const payload = decodePayload(input.rawBody);
  const order = requiredObject(payload.data?.order, 'MALFORMED_CASHFREE_ORDER');
  const payment = requiredObject(payload.data?.payment, 'MALFORMED_CASHFREE_PAYMENT');
  const nativeStatus = requiredString(payment.payment_status, 'MALFORMED_CASHFREE_STATUS');
  const nativeCurrency = requiredString(payment.payment_currency ?? order.order_currency, 'MALFORMED_CASHFREE_CURRENCY');
  const nativeAmountText = requiredString(payment.payment_amount, 'MALFORMED_CASHFREE_AMOUNT');

  return {
    provider: 'CASHFREE',
    environment: 'TEST',
    source: 'WEBHOOK',
    providerEventId: optionalNonEmptyString(payment.cf_payment_id),
    providerOrderRef: requiredString(order.order_id, 'MALFORMED_CASHFREE_ORDER_REF'),
    providerTransactionRef: optionalNonEmptyString(payment.cf_payment_id),
    nativeStatus,
    nativeReasonCode: optionalNonEmptyString(payment.payment_error_code),
    amountPaise: nativeCurrency === 'INR' ? parseInrPaise(nativeAmountText) : null,
    nativeAmountText,
    nativeCurrency,
    evidenceAuthority: 'ACTIVATION_GATED',
    mappedOutcome: mapCashfreeStatus(nativeStatus),
    adapterVersion: CASHFREE_ADAPTER_VERSION,
    mappingVersion: CASHFREE_MAPPING_VERSION,
    providerApiVersion: CASHFREE_PROVIDER_API_VERSION,
    providerOccurredAt: optionalDate(payment.payment_time ?? payload.event_time),
  };
}

function mapCashfreeStatus(status: string): ParsedObservationFields['mappedOutcome'] {
  if (status === 'SUCCESS') return 'SUCCEEDED';
  if (status === 'PENDING') return 'PENDING';
  if (failureStatuses.has(status)) return 'FAILED_TERMINAL';
  return 'UNMAPPED';
}

function decodePayload(rawBody: Buffer): CashfreePayload {
  const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
  if (!isRecord(parsed)) throw new Error('MALFORMED_CASHFREE_PAYLOAD');
  return parsed as CashfreePayload;
}

function requiredObject(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message);
  return value;
}

function optionalNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return new Date(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
