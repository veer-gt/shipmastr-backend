import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { parseInrPaise } from '../money.js';
import type { ObservationParser, ParsedObservationFields, RawObservationInput } from './providerAdapter.js';

export type PaytmChecksumRepresentation =
  | { kind: 'FORM_PARAMS'; params: Readonly<Record<string, string | null | undefined>> }
  | { kind: 'JSON_BODY'; body: string };

export interface PaytmChecksumInput {
  representation: PaytmChecksumRepresentation;
  merchantKey: string;
  checksum: string;
}

const PAYTM_ADAPTER_VERSION = 'paytm-contract-fixture-v1';
const PAYTM_MAPPING_VERSION = 'paytm-fixture-map-v1';
const PAYTM_PROVIDER_API_VERSION = 'paytm-checksum-contract-c8d5803d8b3c01fe73ee5a7b7c89b892180aea22';
const PAYTM_IV = Buffer.from('@@@@&&&&####$$$$');

export const paytmContractParser: ObservationParser = {
  provider: 'PAYTM',
  adapterVersion: PAYTM_ADAPTER_VERSION,
  mappingVersion: PAYTM_MAPPING_VERSION,
  parse(input) {
    return parsePaytmObservation(input);
  },
};

export function verifyPaytmChecksum({ representation, merchantKey, checksum }: PaytmChecksumInput): boolean {
  const canonical = representation.kind === 'JSON_BODY'
    ? representation.body
    : Object.keys(representation.params)
      .filter((key) => key !== 'CHECKSUMHASH')
      .sort()
      .map((key) => normaliseChecksumValue(representation.params[key]))
      .join('|');

  let decrypted: string;
  try {
    decrypted = decryptPaytmChecksum(checksum, merchantKey, PAYTM_IV);
  } catch {
    return false;
  }

  const salt = decrypted.slice(-4);
  const expected = createHash('sha256')
    .update(`${canonical}|${salt}`, 'utf8')
    .digest('hex') + salt;
  return constantTimeUtf8Equal(decrypted, expected);
}

function parsePaytmObservation(input: RawObservationInput): ParsedObservationFields {
  const payload = decodePayload(input.rawBody);
  const body = isRecord(payload.body) ? payload.body : payload;
  const resultInfo = isRecord(body.resultInfo) ? body.resultInfo : {};
  const isJsonRepresentation = isRecord(payload.body);
  const nativeStatus = requiredString(body.STATUS ?? resultInfo.resultStatus, 'MALFORMED_PAYTM_STATUS');
  const nativeCurrency = requiredString(body.CURRENCY ?? body.currency, 'MALFORMED_PAYTM_CURRENCY');
  const nativeAmountText = requiredString(body.TXNAMOUNT ?? body.txnAmount, 'MALFORMED_PAYTM_AMOUNT');
  const providerOrderRef = requiredString(body.ORDERID ?? body.orderId, 'MALFORMED_PAYTM_ORDER_REF');
  const providerTransactionRef = optionalNonEmptyString(body.TXNID ?? body.txnId);

  return {
    provider: 'PAYTM',
    environment: 'TEST',
    source: isJsonRepresentation ? 'STATUS_QUERY' : 'WEBHOOK',
    providerEventId: providerTransactionRef ?? providerOrderRef,
    providerOrderRef,
    providerTransactionRef,
    nativeStatus,
    nativeReasonCode: optionalNonEmptyString(body.RESPCODE ?? resultInfo.resultCode),
    amountPaise: nativeCurrency === 'INR' ? parseInrPaise(nativeAmountText) : null,
    nativeAmountText,
    nativeCurrency,
    evidenceAuthority: 'ACTIVATION_GATED',
    mappedOutcome: mapPaytmStatus(nativeStatus),
    adapterVersion: PAYTM_ADAPTER_VERSION,
    mappingVersion: PAYTM_MAPPING_VERSION,
    providerApiVersion: PAYTM_PROVIDER_API_VERSION,
    providerOccurredAt: optionalDate(body.TXNDATE ?? body.txnDate),
  };
}

function mapPaytmStatus(status: string): ParsedObservationFields['mappedOutcome'] {
  if (status === 'TXN_SUCCESS') return 'SUCCEEDED';
  if (status === 'PENDING') return 'PENDING';
  if (status === 'TXN_FAILURE') return 'FAILED_TERMINAL';
  return 'UNMAPPED';
}

function decryptPaytmChecksum(checksum: string, merchantKey: string, iv: Buffer): string {
  const decipher = createDecipheriv('AES-128-CBC', merchantKey, iv);
  return Buffer.concat([
    decipher.update(Buffer.from(checksum, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function constantTimeUtf8Equal(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function normaliseChecksumValue(value: string | null | undefined): string {
  return value == null ? '' : String(value);
}

function decodePayload(rawBody: Buffer): Record<string, unknown> {
  const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
  if (!isRecord(parsed)) throw new Error('MALFORMED_PAYTM_PAYLOAD');
  return parsed;
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
