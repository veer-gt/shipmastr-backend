import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pgo1Telemetry, type Pgo1TelemetryEvent } from '../telemetry.js';

class RecordingSink {
  readonly events: Array<{ payload: unknown; message: string }> = [];

  warn(payload: unknown, message: string) {
    this.events.push({ payload, message });
  }
}

const eventFixtures: Pgo1TelemetryEvent[] = [
  { type: 'UNRESOLVED_AGE', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', provider: 'PAYTM', reason: 'OLDER_THAN_15M' },
  { type: 'TIMEOUT_TO_UNKNOWN', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', provider: 'PAYTM', nativeStatus: 'TIMEOUT' },
  { type: 'RECONCILIATION_SLA_BREACH', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', provider: 'MOCK', policyVersion: 'mock-reconciliation-v1' },
  { type: 'POLICY_DISABLED', merchantId: 'm_1', provider: 'MOCK', policyVersion: 'mock-reconciliation-v1', reason: 'POLICY_DISABLED' },
  { type: 'MAPPING_GAP', merchantId: 'm_1', attemptId: 'a_1', provider: 'PAYTM', mappingVersion: 'v1', nativeStatus: 'NEW_CODE' },
  { type: 'SIGNATURE_FAILURE', merchantId: 'm_1', attemptId: 'a_1', provider: 'PAYTM', nativeStatus: 'TXN_SUCCESS', reason: 'CHECKSUM_MISMATCH' },
  { type: 'BINDING_MISMATCH', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', provider: 'PAYTM', reason: 'MERCHANT_MISMATCH' },
  { type: 'CREDENTIAL_LIFECYCLE_FAILURE', merchantId: 'm_1', attemptId: 'a_1', provider: 'PAYTM', reason: 'CREDENTIAL_CONTEXT_UNAVAILABLE' },
  { type: 'AMOUNT_CURRENCY_REFERENCE_MISMATCH', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', provider: 'CASHFREE', reason: 'AMOUNT_MISMATCH' },
  { type: 'INTEGRITY_CONFLICT', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', provider: 'PAYTM', reason: 'DUPLICATE_EVENT_DIFFERENT_HASH' },
  { type: 'CONTRADICTORY_EVIDENCE', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', provider: 'PAYTM', reason: 'SUCCESS_AFTER_FAILURE' },
  { type: 'DOUBLE_SUCCESS_DETECTED', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', provider: 'PAYTM', reason: 'SURPLUS_DOUBLE_SUCCESS' },
  { type: 'REFUND_DUE_AGING', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', provider: 'CASHFREE', reason: 'OLDER_THAN_24H' },
  { type: 'REFUND_DUE_ESCALATED', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', provider: 'CASHFREE', reason: 'ESCALATION_HORIZON_REACHED' },
  { type: 'REDUCER_FAILURE', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', reason: 'PLAN_BUILD_FAILED' },
  { type: 'REDUCER_LAG', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', reason: 'QUEUE_DELAY_GT_30S' },
  { type: 'OUTBOX_DUPLICATE', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', reason: 'DEDUPE_KEY_REPLAY' },
  { type: 'OUTBOX_BACKLOG', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', reason: 'OUTBOX_AGE_GT_5M' },
  { type: 'OUTBOX_VALIDATION_FAILURE', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', reason: 'PROHIBITED_FIELD' },
  { type: 'PROHIBITED_SHADOW_MUTATION', merchantId: 'm_1', attemptId: 'a_1', obligationId: 'o_1', reason: 'WRITE_METHOD_EXPOSED' },
];

describe('Pgo1Telemetry', () => {
  it('emits every listed telemetry type through the sanitized logger-compatible sink', () => {
    const sink = new RecordingSink();
    const telemetry = new Pgo1Telemetry(sink);

    for (const event of eventFixtures) {
      telemetry.emit(event);
    }

    assert.equal(sink.events.length, eventFixtures.length);
    for (const [{ payload, message }, expected] of sink.events.map((entry, index) => [entry, eventFixtures[index]!] as const)) {
      assert.equal(message, 'pgo1_telemetry');
      assert.deepEqual(payload, {
        event: {
          ...expected,
          containsPii: false,
        },
      });
      assert.doesNotMatch(JSON.stringify(payload), /rawBody|buyerPhone|buyerEmail|4111111111111111|\+919900000001/i);
    }
  });

  it('rejects prohibited telemetry fields before anything reaches the sink', () => {
    const sink = new RecordingSink();
    const telemetry = new Pgo1Telemetry(sink);

    assert.throws(
      () => telemetry.emit({
        type: 'SIGNATURE_FAILURE',
        merchantId: 'm_1',
        attemptId: 'a_1',
        provider: 'PAYTM',
        reason: 'CHECKSUM_MISMATCH',
        rawBody: '{}',
      } as never),
      /PROHIBITED_TELEMETRY_FIELD/,
    );
    assert.equal(sink.events.length, 0);
  });

  it('rejects fixture pii even when it appears inside an allowed field', () => {
    const sink = new RecordingSink();
    const telemetry = new Pgo1Telemetry(sink);

    assert.throws(
      () => telemetry.emit({
        type: 'MAPPING_GAP',
        merchantId: 'm_1',
        attemptId: 'a_1',
        provider: 'CASHFREE',
        mappingVersion: 'v1',
        nativeStatus: 'cashfree.success@example.invalid',
      }),
      /PII_FORBIDDEN_IN_TELEMETRY/,
    );

    assert.throws(
      () => telemetry.emit({
        type: 'MAPPING_GAP',
        merchantId: 'm_1',
        attemptId: 'a_1',
        provider: 'CASHFREE',
        mappingVersion: 'v1',
        nativeStatus: '4111111111111111',
      }),
      /PII_FORBIDDEN_IN_TELEMETRY/,
    );
    assert.equal(sink.events.length, 0);
  });
});
