import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reduceEvidence } from '../reducer.js';
import type { CanonicalObservation, ReduceEvidenceInput, ReductionPlan } from '../types.js';

function buildAttempt(
  overrides: Partial<ReduceEvidenceInput['attempts'][number]> = {},
): ReduceEvidenceInput['attempts'][number] {
  return {
    id: 'attempt_1',
    obligationId: 'obligation_1',
    merchantId: 'merchant_1',
    provider: 'MOCK',
    environment: 'TEST',
    credentialBindingId: 'binding_1',
    providerOrderRef: 'order_1',
    requestIdempotencyKey: 'idem_1',
    adapterVersion: 'adapter_v1',
    mappingVersion: 'mapping_v1',
    outcomeStatus: 'PENDING',
    reviewStatus: 'NOT_REQUIRED',
    resolvedAt: null,
    ...overrides,
  };
}

function buildObservation(
  overrides: Partial<CanonicalObservation> = {},
): CanonicalObservation {
  return {
    id: 'obs_1',
    attemptId: 'attempt_1',
    obligationId: 'obligation_1',
    merchantId: 'merchant_1',
    provider: 'MOCK',
    environment: 'TEST',
    credentialBindingId: 'binding_1',
    credentialVersionId: 'credential_version_1',
    source: 'MOCK',
    providerEventId: 'event_1',
    providerOrderRef: 'order_1',
    providerTransactionRef: 'txn_1',
    nativeStatus: 'captured',
    nativeReasonCode: null,
    amountPaise: 10_000n,
    nativeAmountText: '100.00',
    nativeCurrency: 'INR',
    rawBodyHash: 'hash_1',
    hashAlgorithm: 'SHA-256',
    signatureVerification: 'NOT_APPLICABLE',
    bindingVerification: 'VERIFIED',
    evidenceAuthority: 'ELIGIBLE',
    mappedOutcome: 'SUCCEEDED',
    adapterVersion: 'adapter_v1',
    mappingVersion: 'mapping_v1',
    providerApiVersion: 'mock-2026-08-27',
    providerOccurredAt: new Date('2026-08-27T12:00:00.000Z'),
    receivedAt: new Date('2026-08-27T12:00:01.000Z'),
    reductionDisposition: 'ACCEPTED',
    ...overrides,
  };
}

function buildInput(observations: CanonicalObservation[], attempts?: ReduceEvidenceInput['attempts']): ReduceEvidenceInput {
  const resolvedAttempts = attempts ?? [buildAttempt()];
  return {
    obligation: {
      id: 'obligation_1',
      merchantId: 'merchant_1',
      amountPaise: 10_000n,
      currency: 'INR',
      status: 'OPEN',
    },
    targetAttemptId: resolvedAttempts[0]!.id,
    attempts: resolvedAttempts,
    observations,
    triggeringObservationId: observations.at(-1)?.id ?? null,
    triggeringObservationIsNew: true,
  };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [items.slice()];
  }

  const result: T[][] = [];
  items.forEach((item, index) => {
    const rest = items.slice(0, index).concat(items.slice(index + 1));
    for (const tail of permutations(rest)) {
      result.push([item, ...tail]);
    }
  });
  return result;
}

function semantic(plan: ReductionPlan) {
  return {
    ...plan,
    factTypes: [...plan.factTypes].sort(),
    factEmissions: [...plan.factEmissions].sort((left, right) =>
      `${left.factType}:${left.sourceAttemptId}:${left.sourceObservationId}`.localeCompare(
        `${right.factType}:${right.sourceAttemptId}:${right.sourceObservationId}`,
      ),
    ),
    refundDue: [...plan.refundDue].sort((left, right) =>
      `${left.providerTransactionRef}:${left.reason}:${left.sourceAttemptId}:${left.sourceObservationId}`.localeCompare(
        `${right.providerTransactionRef}:${right.reason}:${right.sourceAttemptId}:${right.sourceObservationId}`,
      ),
    ),
    attention: [...plan.attention].sort((left, right) => left.type.localeCompare(right.type)),
    relatedAttemptActions: [...plan.relatedAttemptActions].sort((left, right) =>
      `${left.attemptId}:${left.action}`.localeCompare(`${right.attemptId}:${right.action}`),
    ),
  };
}

describe('reduceEvidence permutation stability', () => {
  const cases: Array<{
    name: string;
    input: ReduceEvidenceInput;
  }> = [
    {
      name: 'success plus contradictory failure',
      input: buildInput([
        buildObservation({
          id: 'pending_1',
          providerEventId: 'event_pending_1',
          providerTransactionRef: null,
          nativeStatus: 'pending',
          mappedOutcome: 'PENDING',
        }),
        buildObservation({
          id: 'failure_1',
          providerEventId: 'event_failure_1',
          providerTransactionRef: null,
          nativeStatus: 'failed',
          mappedOutcome: 'FAILED_TERMINAL',
        }),
        buildObservation({
          id: 'success_1',
          providerEventId: 'event_success_1',
          providerTransactionRef: 'txn_success_1',
          mappedOutcome: 'SUCCEEDED',
        }),
      ]),
    },
    {
      name: 'mapping gap blocks terminal failure',
      input: buildInput([
        buildObservation({
          id: 'failure_2',
          providerEventId: 'event_failure_2',
          providerTransactionRef: null,
          nativeStatus: 'failed',
          mappedOutcome: 'FAILED_TERMINAL',
        }),
        buildObservation({
          id: 'gap_1',
          providerEventId: 'event_gap_1',
          providerTransactionRef: null,
          nativeStatus: 'mystery',
          mappedOutcome: 'UNMAPPED',
        }),
        buildObservation({
          id: 'pending_2',
          providerEventId: 'event_pending_2',
          providerTransactionRef: null,
          nativeStatus: 'pending',
          mappedOutcome: 'PENDING',
        }),
      ]),
    },
    {
      name: 'duplicate replays and a verified success',
      input: buildInput([
        buildObservation({
          id: 'dup_1',
          providerEventId: 'event_dup',
          rawBodyHash: 'same_hash',
          providerTransactionRef: 'txn_dup',
        }),
        buildObservation({
          id: 'dup_2',
          providerEventId: 'event_dup',
          rawBodyHash: 'same_hash',
          providerTransactionRef: 'txn_dup',
          receivedAt: new Date('2026-08-27T12:00:03.000Z'),
        }),
        buildObservation({
          id: 'unknown_1',
          providerEventId: 'event_unknown_1',
          providerTransactionRef: null,
          nativeStatus: 'pending',
          mappedOutcome: 'PENDING',
        }),
      ]),
    },
    {
      name: 'five-observation double-success case',
      input: buildInput(
        [
          buildObservation({
            id: 'attempt_a_success',
            attemptId: 'attempt_a',
            providerOrderRef: 'order_a',
            providerEventId: 'event_a_success',
            providerTransactionRef: 'txn_a',
          }),
          buildObservation({
            id: 'attempt_b_pending',
            attemptId: 'attempt_b',
            providerOrderRef: 'order_b',
            providerEventId: 'event_b_pending',
            providerTransactionRef: null,
            nativeStatus: 'pending',
            mappedOutcome: 'PENDING',
          }),
          buildObservation({
            id: 'attempt_b_success',
            attemptId: 'attempt_b',
            providerOrderRef: 'order_b',
            providerEventId: 'event_b_success',
            providerTransactionRef: 'txn_b',
          }),
          buildObservation({
            id: 'attempt_b_failure',
            attemptId: 'attempt_b',
            providerOrderRef: 'order_b',
            providerEventId: 'event_b_failure',
            providerTransactionRef: null,
            nativeStatus: 'failed',
            mappedOutcome: 'FAILED_TERMINAL',
          }),
          buildObservation({
            id: 'attempt_b_dup',
            attemptId: 'attempt_b',
            providerOrderRef: 'order_b',
            providerEventId: 'event_b_success',
            providerTransactionRef: 'txn_b',
            rawBodyHash: 'hash_b_duplicate',
          }),
        ],
        [
          buildAttempt({
            id: 'attempt_a',
            providerOrderRef: 'order_a',
            outcomeStatus: 'SUCCEEDED',
            resolvedAt: new Date('2026-08-27T11:00:00.000Z'),
          }),
          buildAttempt({
            id: 'attempt_b',
            providerOrderRef: 'order_b',
            outcomeStatus: 'PENDING',
          }),
        ],
      ),
    },
  ];

  for (const testCase of cases) {
    it(`keeps ${testCase.name} arrival-order independent`, () => {
      const expected = semantic(reduceEvidence(testCase.input));

      for (const order of permutations(testCase.input.observations)) {
        const actual = semantic(reduceEvidence({ ...testCase.input, observations: order }));
        assert.deepEqual(actual, expected);
      }
    });
  }
});
