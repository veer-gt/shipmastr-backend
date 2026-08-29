import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reduceEvidence } from '../reducer.js';
import type {
  CanonicalObservation,
  ReduceEvidenceInput,
  ReductionPlan,
  RelatedAttemptAction,
} from '../types.js';

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
    id: 'observation_1',
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

function buildInput(
  overrides: {
    obligation?: Partial<ReduceEvidenceInput['obligation']>;
    attempts?: ReduceEvidenceInput['attempts'];
    observations?: CanonicalObservation[];
    targetAttemptId?: string;
    triggeringObservationId?: string | null;
    triggeringObservationIsNew?: boolean;
  } = {},
): ReduceEvidenceInput {
  const attempts = overrides.attempts ?? [buildAttempt()];
  const observations = overrides.observations ?? [];
  return {
    obligation: {
      id: 'obligation_1',
      merchantId: 'merchant_1',
      amountPaise: 10_000n,
      currency: 'INR',
      status: 'OPEN',
      ...overrides.obligation,
    },
    targetAttemptId: overrides.targetAttemptId ?? attempts[0]!.id,
    attempts,
    observations,
    triggeringObservationId:
      overrides.triggeringObservationId === undefined
        ? observations.at(-1)?.id ?? null
        : overrides.triggeringObservationId,
    triggeringObservationIsNew: overrides.triggeringObservationIsNew ?? true,
  };
}

function pendingSet(): ReduceEvidenceInput {
  return buildInput({
    observations: [
      buildObservation({
        id: 'pending_1',
        providerEventId: 'event_pending_1',
        providerTransactionRef: null,
        nativeStatus: 'pending',
        mappedOutcome: 'PENDING',
      }),
      buildObservation({
        id: 'success_1',
        providerEventId: 'event_success_1',
        providerTransactionRef: 'txn_success_1',
        nativeStatus: 'captured',
        mappedOutcome: 'SUCCEEDED',
      }),
    ],
  });
}

function terminalFailureSet(): ReduceEvidenceInput {
  return buildInput({
    observations: [
      buildObservation({
        id: 'failure_1',
        providerEventId: 'event_failure_1',
        providerTransactionRef: null,
        nativeStatus: 'failed',
        mappedOutcome: 'FAILED_TERMINAL',
      }),
    ],
  });
}

function timeoutSet(): ReduceEvidenceInput {
  return buildInput({
    observations: [
      buildObservation({
        id: 'timeout_1',
        providerEventId: 'event_timeout_1',
        providerTransactionRef: null,
        nativeStatus: 'timeout',
        mappedOutcome: 'UNKNOWN',
      }),
    ],
  });
}

function unknownThenSuccessSet(): ReduceEvidenceInput {
  return buildInput({
    observations: [
      buildObservation({
        id: 'unknown_1',
        providerEventId: 'event_unknown_1',
        providerTransactionRef: null,
        nativeStatus: 'review',
        mappedOutcome: 'UNKNOWN',
      }),
      buildObservation({
        id: 'success_2',
        providerEventId: 'event_success_2',
        providerTransactionRef: 'txn_success_2',
        nativeStatus: 'captured',
        mappedOutcome: 'SUCCEEDED',
      }),
    ],
  });
}

function successThenFailureSet(): ReduceEvidenceInput {
  return buildInput({
    observations: [
      buildObservation({
        id: 'success_3',
        providerEventId: 'event_success_3',
        providerTransactionRef: 'txn_success_3',
        mappedOutcome: 'SUCCEEDED',
      }),
      buildObservation({
        id: 'failure_2',
        providerEventId: 'event_failure_2',
        providerTransactionRef: null,
        nativeStatus: 'failed',
        mappedOutcome: 'FAILED_TERMINAL',
      }),
    ],
  });
}

function failureThenSuccessSet(): ReduceEvidenceInput {
  return buildInput({
    observations: [
      buildObservation({
        id: 'failure_3',
        providerEventId: 'event_failure_3',
        providerTransactionRef: null,
        nativeStatus: 'failed',
        mappedOutcome: 'FAILED_TERMINAL',
      }),
      buildObservation({
        id: 'success_4',
        providerEventId: 'event_success_4',
        providerTransactionRef: 'txn_success_4',
        mappedOutcome: 'SUCCEEDED',
      }),
    ],
  });
}

function mappingGapSet(): ReduceEvidenceInput {
  return buildInput({
    observations: [
      buildObservation({
        id: 'gap_1',
        providerEventId: 'event_gap_1',
        providerTransactionRef: null,
        nativeStatus: 'mystery',
        mappedOutcome: 'UNMAPPED',
      }),
    ],
  });
}

function terminalFailureAndMappingGapSet(): ReduceEvidenceInput {
  return buildInput({
    observations: [
      buildObservation({
        id: 'failure_4',
        providerEventId: 'event_failure_4',
        providerTransactionRef: null,
        nativeStatus: 'failed',
        mappedOutcome: 'FAILED_TERMINAL',
      }),
      buildObservation({
        id: 'gap_2',
        providerEventId: 'event_gap_2',
        providerTransactionRef: null,
        nativeStatus: 'mystery',
        mappedOutcome: 'UNMAPPED',
      }),
    ],
  });
}

function assertRefund(plan: ReductionPlan, expected: ReductionPlan['refundDue']) {
  assert.deepEqual(plan.refundDue, expected);
}

function assertRelatedActions(
  plan: ReductionPlan,
  expected: Array<{ attemptId: string; action: RelatedAttemptAction }>,
) {
  assert.deepEqual(plan.relatedAttemptActions, expected);
}

describe('reduceEvidence', () => {
  for (const [name, input, expected] of [
    ['pending to success', pendingSet(), 'SUCCEEDED'],
    ['pending to terminal failure', terminalFailureSet(), 'FAILED_TERMINAL'],
    ['timeout to unknown', timeoutSet(), 'UNKNOWN'],
    ['unknown followed by success', unknownThenSuccessSet(), 'SUCCEEDED'],
    ['success followed by failure', successThenFailureSet(), 'SUCCEEDED'],
    ['failure followed by verified success', failureThenSuccessSet(), 'SUCCEEDED'],
    ['unmapped status', mappingGapSet(), 'UNKNOWN'],
    ['mapped terminal failure plus unmapped status', terminalFailureAndMappingGapSet(), 'UNKNOWN'],
  ] as const) {
    it(name, () => {
      assert.equal(reduceEvidence(input).outcomeStatus, expected);
    });
  }

  it('treats same event id and same hash as an idempotent duplicate with no new fact', () => {
    const plan = reduceEvidence(
      buildInput({
        observations: [
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
            receivedAt: new Date('2026-08-27T12:00:05.000Z'),
          }),
        ],
        triggeringObservationId: 'dup_1',
        triggeringObservationIsNew: false,
      }),
    );

    assert.deepEqual(plan.factTypes, []);
    assert.deepEqual(plan.factEmissions, []);
    assert.deepEqual(plan.attention, []);
    assertRefund(plan, []);
  });

  it('treats same event id and different hash while unresolved as integrity conflict', () => {
    const plan = reduceEvidence(
      buildInput({
        observations: [
          buildObservation({
            id: 'conflict_1',
            providerEventId: 'event_conflict',
            rawBodyHash: 'hash_a',
            providerTransactionRef: 'txn_conflict',
          }),
          buildObservation({
            id: 'conflict_2',
            providerEventId: 'event_conflict',
            rawBodyHash: 'hash_b',
            providerTransactionRef: 'txn_conflict',
          }),
        ],
      }),
    );

    assert.equal(plan.outcomeStatus, 'PENDING');
    assert.equal(plan.resolved, false);
    assert.equal(plan.reviewStatus, 'REQUIRED');
    assert.equal(plan.disposition, 'INTEGRITY_CONFLICT');
    assert.deepEqual(plan.attention, [{ type: 'INTEGRITY_CONFLICT' }]);
    assert.deepEqual(plan.factTypes, []);
  });

  it('preserves the resolved outcome when the same integrity conflict arrives after resolution', () => {
    const plan = reduceEvidence(
      buildInput({
        attempts: [
          buildAttempt({
            outcomeStatus: 'FAILED_TERMINAL',
            reviewStatus: 'NOT_REQUIRED',
            resolvedAt: new Date('2026-08-27T12:00:00.000Z'),
          }),
        ],
        observations: [
          buildObservation({
            id: 'resolved_conflict_1',
            providerEventId: 'event_resolved_conflict',
            rawBodyHash: 'hash_a',
          }),
          buildObservation({
            id: 'resolved_conflict_2',
            providerEventId: 'event_resolved_conflict',
            rawBodyHash: 'hash_b',
          }),
        ],
      }),
    );

    assert.equal(plan.outcomeStatus, 'FAILED_TERMINAL');
    assert.equal(plan.resolved, true);
    assert.equal(plan.attention[0]?.type, 'INTEGRITY_CONFLICT');
    assert.equal(plan.disposition, 'INTEGRITY_CONFLICT_POST_RESOLUTION');
  });

  it('creates a late-success refund case for expired or cancelled obligations', () => {
    const plan = reduceEvidence(
      buildInput({
        obligation: { status: 'EXPIRED' },
        observations: [
          buildObservation({
            id: 'late_success_1',
            providerEventId: 'event_late_success_1',
            providerTransactionRef: 'txn_late_1',
          }),
        ],
      }),
    );

    assert.equal(plan.outcomeStatus, 'SUCCEEDED');
    assert.equal(plan.satisfyObligation, false);
    assert.deepEqual(plan.factTypes, ['PAYMENT_SUCCEEDED', 'REFUND_DUE_DETECTED']);
    assertRefund(plan, [
      {
        captureKey: 'merchant_1:obligation_1:MOCK:txn_late_1',
        providerTransactionRef: 'txn_late_1',
        reason: 'LATE_SUCCESS_AFTER_CLOSURE',
        sourceAttemptId: 'attempt_1',
        sourceObservationId: 'late_success_1',
        provider: 'MOCK',
      },
    ]);
  });

  it('detects a distinct second captured success as surplus double success', () => {
    const attemptA = buildAttempt({
      id: 'attempt_a',
      providerOrderRef: 'order_a',
      outcomeStatus: 'SUCCEEDED',
      resolvedAt: new Date('2026-08-27T11:00:00.000Z'),
    });
    const attemptB = buildAttempt({
      id: 'attempt_b',
      providerOrderRef: 'order_b',
      outcomeStatus: 'PENDING',
    });
    const plan = reduceEvidence(
      buildInput({
        obligation: { status: 'SATISFIED' },
        attempts: [attemptA, attemptB],
        targetAttemptId: attemptB.id,
        observations: [
          buildObservation({
            id: 'success_a',
            attemptId: attemptA.id,
            providerOrderRef: attemptA.providerOrderRef!,
            providerEventId: 'event_success_a',
            providerTransactionRef: 'txn_a',
          }),
          buildObservation({
            id: 'success_b',
            attemptId: attemptB.id,
            providerOrderRef: attemptB.providerOrderRef!,
            providerEventId: 'event_success_b',
            providerTransactionRef: 'txn_b',
          }),
        ],
      }),
    );

    assert.equal(plan.outcomeStatus, 'SUCCEEDED');
    assert.equal(plan.disposition, 'DOUBLE_SUCCESS_DETECTED');
    assert.deepEqual(plan.attention, [{ type: 'DOUBLE_SUCCESS_DETECTED' }]);
    assert.deepEqual(plan.factTypes, ['PAYMENT_SUCCEEDED', 'REFUND_DUE_DETECTED']);
    assertRefund(plan, [
      {
        captureKey: 'merchant_1:obligation_1:MOCK:txn_b',
        providerTransactionRef: 'txn_b',
        reason: 'SURPLUS_DOUBLE_SUCCESS',
        sourceAttemptId: 'attempt_b',
        sourceObservationId: 'success_b',
        provider: 'MOCK',
      },
    ]);
    assertRelatedActions(plan, [{ attemptId: 'attempt_a', action: 'PRESERVE_TERMINAL' }]);
  });

  it('attributes a newly observed surplus to the triggering target capture', () => {
    const attemptA = buildAttempt({
      id: 'attempt_legit_a',
      providerOrderRef: 'order_legit_a',
      outcomeStatus: 'SUCCEEDED',
      resolvedAt: new Date('2026-08-27T10:00:00.000Z'),
    });
    const attemptB = buildAttempt({
      id: 'attempt_legit_b',
      providerOrderRef: 'order_legit_b',
      outcomeStatus: 'SUCCEEDED',
      resolvedAt: new Date('2026-08-27T11:00:00.000Z'),
    });

    const plan = reduceEvidence(
      buildInput({
        obligation: { status: 'SATISFIED' },
        attempts: [attemptA, attemptB],
        targetAttemptId: attemptB.id,
        observations: [
          buildObservation({
            id: 'success_legit_a',
            attemptId: attemptA.id,
            providerOrderRef: attemptA.providerOrderRef!,
            providerEventId: 'event_success_legit_a',
            providerTransactionRef: 'txn_legit_a',
          }),
          buildObservation({
            id: 'success_legit_b',
            attemptId: attemptB.id,
            providerOrderRef: attemptB.providerOrderRef!,
            providerEventId: 'event_success_legit_b',
            providerTransactionRef: 'txn_legit_b',
          }),
        ],
      }),
    );

    assert.equal(plan.outcomeStatus, 'SUCCEEDED');
    assert.equal(plan.disposition, 'DOUBLE_SUCCESS_DETECTED');
    assertRefund(plan, [
      {
        captureKey: 'merchant_1:obligation_1:MOCK:txn_legit_b',
        providerTransactionRef: 'txn_legit_b',
        reason: 'SURPLUS_DOUBLE_SUCCESS',
        sourceAttemptId: 'attempt_legit_b',
        sourceObservationId: 'success_legit_b',
        provider: 'MOCK',
      },
    ]);
  });

  it('does not let a terminal failure from one attempt resolve a later target attempt', () => {
    const prior = buildAttempt({
      id: 'attempt_prior_failure',
      providerOrderRef: 'order_prior_failure',
      outcomeStatus: 'FAILED_TERMINAL',
      resolvedAt: new Date('2026-08-27T10:00:00.000Z'),
    });
    const target = buildAttempt({
      id: 'attempt_later_pending',
      providerOrderRef: 'order_later_pending',
    });
    const plan = reduceEvidence(buildInput({
      attempts: [prior, target],
      targetAttemptId: target.id,
      observations: [
        buildObservation({
          id: 'prior_failure_evidence',
          attemptId: prior.id,
          providerOrderRef: prior.providerOrderRef!,
          providerEventId: 'event_prior_failure',
          providerTransactionRef: null,
          mappedOutcome: 'FAILED_TERMINAL',
        }),
        buildObservation({
          id: 'later_pending_evidence',
          attemptId: target.id,
          providerOrderRef: target.providerOrderRef!,
          providerEventId: 'event_later_pending',
          providerTransactionRef: null,
          mappedOutcome: 'PENDING',
        }),
      ],
    }));

    assert.equal(plan.attemptId, target.id);
    assert.equal(plan.outcomeStatus, 'PENDING');
    assert.equal(plan.resolved, false);
    assert.deepEqual(plan.factTypes, []);
  });

  it('does not let a mapping gap from one attempt block terminal failure on its source attempt', () => {
    const prior = buildAttempt({
      id: 'attempt_prior_gap',
      providerOrderRef: 'order_prior_gap',
      outcomeStatus: 'UNKNOWN',
    });
    const target = buildAttempt({
      id: 'attempt_target_failure',
      providerOrderRef: 'order_target_failure',
    });
    const plan = reduceEvidence(buildInput({
      attempts: [prior, target],
      targetAttemptId: target.id,
      observations: [
        buildObservation({
          id: 'prior_gap_evidence',
          attemptId: prior.id,
          providerOrderRef: prior.providerOrderRef!,
          providerEventId: 'event_prior_gap',
          providerTransactionRef: null,
          mappedOutcome: 'UNMAPPED',
        }),
        buildObservation({
          id: 'target_failure_evidence',
          attemptId: target.id,
          providerOrderRef: target.providerOrderRef!,
          providerEventId: 'event_target_failure',
          providerTransactionRef: null,
          mappedOutcome: 'FAILED_TERMINAL',
        }),
      ],
    }));

    assert.equal(plan.outcomeStatus, 'FAILED_TERMINAL');
    assert.equal(plan.resolved, true);
    assert.deepEqual(plan.factEmissions, [{
      factType: 'PAYMENT_FAILED',
      sourceAttemptId: target.id,
      sourceObservationId: 'target_failure_evidence',
      provider: 'MOCK',
      providerReferenceId: 'event_target_failure',
    }]);
  });

  it('scopes provider event identity by provider environment and attempt', () => {
    const prior = buildAttempt({
      id: 'attempt_event_prior',
      providerOrderRef: 'order_event_prior',
    });
    const target = buildAttempt({
      id: 'attempt_event_target',
      providerOrderRef: 'order_event_target',
    });
    const plan = reduceEvidence(buildInput({
      attempts: [prior, target],
      targetAttemptId: target.id,
      observations: [
        buildObservation({
          id: 'same_event_prior',
          attemptId: prior.id,
          providerOrderRef: prior.providerOrderRef!,
          providerEventId: 'provider_reused_event_id',
          providerTransactionRef: null,
          mappedOutcome: 'PENDING',
          rawBodyHash: 'hash_prior',
        }),
        buildObservation({
          id: 'same_event_target',
          attemptId: target.id,
          providerOrderRef: target.providerOrderRef!,
          providerEventId: 'provider_reused_event_id',
          providerTransactionRef: 'txn_target',
          mappedOutcome: 'SUCCEEDED',
          rawBodyHash: 'hash_target',
        }),
      ],
    }));

    assert.equal(plan.outcomeStatus, 'SUCCEEDED');
    assert.equal(plan.disposition, 'SUCCEEDED');
    assert.equal(plan.attention.some((entry) => entry.type === 'INTEGRITY_CONFLICT'), false);
  });

  it('binds a terminal fact to the new source evidence and does not re-emit historical success', () => {
    const plan = reduceEvidence(buildInput({
      observations: [
        buildObservation({
          id: 'historical_success',
          providerEventId: 'event_historical_success',
          providerTransactionRef: 'txn_historical_success',
          mappedOutcome: 'SUCCEEDED',
        }),
        buildObservation({
          id: 'later_failure',
          providerEventId: 'event_later_failure',
          providerTransactionRef: null,
          nativeStatus: 'failed',
          mappedOutcome: 'FAILED_TERMINAL',
        }),
      ],
      triggeringObservationId: 'later_failure',
    }));

    assert.equal(plan.outcomeStatus, 'SUCCEEDED');
    assert.deepEqual(plan.factTypes, ['PAYMENT_FAILED']);
    assert.deepEqual(plan.factEmissions, [{
      factType: 'PAYMENT_FAILED',
      sourceAttemptId: 'attempt_1',
      sourceObservationId: 'later_failure',
      provider: 'MOCK',
      providerReferenceId: 'event_later_failure',
    }]);
  });

  it('emits success evidence but does not reopen a refund for an already-seen capture identity', () => {
    const primary = buildAttempt({
      id: 'attempt_primary_capture',
      providerOrderRef: 'order_primary_capture',
      outcomeStatus: 'SUCCEEDED',
      resolvedAt: new Date('2026-08-27T10:00:00.000Z'),
    });
    const surplus = buildAttempt({
      id: 'attempt_surplus_capture',
      providerOrderRef: 'order_surplus_capture',
      outcomeStatus: 'SUCCEEDED',
      resolvedAt: new Date('2026-08-27T11:00:00.000Z'),
    });
    const plan = reduceEvidence(buildInput({
      obligation: { status: 'SATISFIED' },
      attempts: [primary, surplus],
      targetAttemptId: surplus.id,
      observations: [
        buildObservation({
          id: 'primary_capture_evidence', attemptId: primary.id,
          providerOrderRef: primary.providerOrderRef!, providerEventId: 'event_primary_capture',
          providerTransactionRef: 'txn_primary_capture',
        }),
        buildObservation({
          id: 'surplus_capture_first', attemptId: surplus.id,
          providerOrderRef: surplus.providerOrderRef!, providerEventId: 'event_surplus_capture_first',
          providerTransactionRef: 'txn_surplus_capture',
        }),
        buildObservation({
          id: 'surplus_capture_later_evidence', attemptId: surplus.id,
          providerOrderRef: surplus.providerOrderRef!, providerEventId: 'event_surplus_capture_later',
          providerTransactionRef: 'txn_surplus_capture',
        }),
      ],
      triggeringObservationId: 'surplus_capture_later_evidence',
    }));

    assert.deepEqual(plan.factEmissions, [{
      factType: 'PAYMENT_SUCCEEDED',
      sourceAttemptId: surplus.id,
      sourceObservationId: 'surplus_capture_later_evidence',
      provider: 'MOCK',
      providerReferenceId: 'txn_surplus_capture',
    }]);
    assertRefund(plan, []);
  });

  it('opens only the newly observed surplus capture when multiple captures arrive sequentially', () => {
    const primary = buildAttempt({
      id: 'attempt_primary',
      providerOrderRef: 'order_primary',
      outcomeStatus: 'SUCCEEDED',
      resolvedAt: new Date('2026-08-27T10:00:00.000Z'),
    });
    const priorSurplus = buildAttempt({
      id: 'attempt_prior_surplus',
      providerOrderRef: 'order_prior_surplus',
      outcomeStatus: 'SUCCEEDED',
      resolvedAt: new Date('2026-08-27T11:00:00.000Z'),
    });
    const target = buildAttempt({
      id: 'attempt_new_surplus',
      providerOrderRef: 'order_new_surplus',
    });
    const plan = reduceEvidence(buildInput({
      obligation: { status: 'SATISFIED' },
      attempts: [primary, priorSurplus, target],
      targetAttemptId: target.id,
      observations: [
        buildObservation({
          id: 'primary_success', attemptId: primary.id,
          providerOrderRef: primary.providerOrderRef!, providerEventId: 'event_primary',
          providerTransactionRef: 'txn_primary',
        }),
        buildObservation({
          id: 'prior_surplus_success', attemptId: priorSurplus.id,
          providerOrderRef: priorSurplus.providerOrderRef!, providerEventId: 'event_prior_surplus',
          providerTransactionRef: 'txn_prior_surplus',
        }),
        buildObservation({
          id: 'new_surplus_success', attemptId: target.id,
          providerOrderRef: target.providerOrderRef!, providerEventId: 'event_new_surplus',
          providerTransactionRef: 'txn_new_surplus',
        }),
      ],
      triggeringObservationId: 'new_surplus_success',
    }));

    assertRefund(plan, [{
      captureKey: 'merchant_1:obligation_1:MOCK:txn_new_surplus',
      providerTransactionRef: 'txn_new_surplus',
      reason: 'SURPLUS_DOUBLE_SUCCESS',
      sourceAttemptId: target.id,
      sourceObservationId: 'new_surplus_success',
      provider: 'MOCK',
    }]);
  });

  it('satisfies an open obligation on verified success after prior failure without refund case', () => {
    const plan = reduceEvidence(failureThenSuccessSet());

    assert.equal(plan.outcomeStatus, 'SUCCEEDED');
    assert.equal(plan.satisfyObligation, true);
    assert.deepEqual(plan.factTypes, ['PAYMENT_SUCCEEDED']);
    assertRefund(plan, []);
    assert.equal(plan.attention[0]?.type, 'CONTRADICTORY_EVIDENCE');
  });

  it('system-completes an in-progress review when new evidence resolves the attempt', () => {
    const plan = reduceEvidence(
      buildInput({
        attempts: [
          buildAttempt({
            reviewStatus: 'IN_PROGRESS',
          }),
        ],
        observations: [
          buildObservation({
            id: 'review_success_1',
            providerEventId: 'event_review_success_1',
            providerTransactionRef: 'txn_review_success_1',
          }),
        ],
      }),
    );

    assert.equal(plan.outcomeStatus, 'SUCCEEDED');
    assert.equal(plan.reviewStatus, 'COMPLETED');
    assert.equal(plan.completedByType, 'SYSTEM');
  });

  it('keeps other unresolved attempts locked when one attempt absorbs a success', () => {
    const target = buildAttempt({
      id: 'attempt_target',
      providerOrderRef: 'order_target',
    });
    const other = buildAttempt({
      id: 'attempt_other',
      providerOrderRef: 'order_other',
    });
    const plan = reduceEvidence(
      buildInput({
        attempts: [target, other],
        targetAttemptId: target.id,
        observations: [
          buildObservation({
            id: 'target_success',
            attemptId: target.id,
            providerOrderRef: target.providerOrderRef!,
            providerEventId: 'event_target_success',
            providerTransactionRef: 'txn_target_success',
          }),
        ],
      }),
    );

    assertRelatedActions(plan, [{ attemptId: other.id, action: 'KEEP_UNRESOLVED_LOCKED' }]);
  });

  it('keeps target review unresolved when another attempt succeeded but the target attempt did not resolve', () => {
    const succeeded = buildAttempt({
      id: 'attempt_a1',
      providerOrderRef: 'order_a1',
      outcomeStatus: 'SUCCEEDED',
      resolvedAt: new Date('2026-08-27T11:00:00.000Z'),
    });
    const target = buildAttempt({
      id: 'attempt_a2',
      providerOrderRef: 'order_a2',
      reviewStatus: 'IN_PROGRESS',
      outcomeStatus: 'PENDING',
      resolvedAt: null,
    });

    const plan = reduceEvidence(
      buildInput({
        attempts: [succeeded, target],
        targetAttemptId: target.id,
        observations: [
          buildObservation({
            id: 'success_a1',
            attemptId: succeeded.id,
            providerOrderRef: succeeded.providerOrderRef!,
            providerEventId: 'event_success_a1',
            providerTransactionRef: 'txn_success_a1',
          }),
        ],
      }),
    );

    assert.equal(plan.outcomeStatus, 'PENDING');
    assert.equal(plan.resolved, false);
    assert.equal(plan.reviewStatus, 'IN_PROGRESS');
    assert.equal(plan.completedByType, null);
    assertRelatedActions(plan, [{ attemptId: succeeded.id, action: 'PRESERVE_TERMINAL' }]);
  });
});
