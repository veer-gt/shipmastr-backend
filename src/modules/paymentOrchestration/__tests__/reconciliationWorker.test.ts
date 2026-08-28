import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PaymentAttempt } from '@prisma/client';
import {
  MOCK_RECONCILIATION_POLICY_V1,
  reconcileAttempt,
  reconciliationWorker,
  type ClaimReadOnlyQueryRequest,
  type CredentialUseInputResolver,
  type DerivedReconciliationState,
  type PendingReadOnlyQueryRequest,
  type ReadOnlyQueryConsumptionRecord,
  type ReconciliationAttempt,
  type ReconciliationDeps,
  type SlaEscalationRequest,
  type SlaEscalationResult,
} from '../reconciliationWorker.js';
import { mockAdapter } from '../adapters/mockAdapter.js';
import type {
  MockStatusQueryInput,
  RawObservationInput,
} from '../adapters/providerAdapter.js';

interface VirtualClock {
  now(): Date;
  advanceBy(deltaMs: number): void;
}

interface PersistenceHistory {
  outcomeTransitions: Array<{
    priorOutcomeStatus: PaymentAttempt['outcomeStatus'];
    nextOutcomeStatus: PaymentAttempt['outcomeStatus'];
  }>;
  reviewHistory: Array<{
    priorReviewStatus: PaymentAttempt['reviewStatus'];
    nextReviewStatus: PaymentAttempt['reviewStatus'];
    reasonCode: string;
  }>;
}

function persistedAttempt(
  overrides: Partial<PaymentAttempt> = {},
): PaymentAttempt {
  return {
    id: 'attempt_1',
    obligationId: 'obligation_1',
    merchantId: 'merchant_1',
    obligationCollectionRail: 'ONLINE',
    provider: 'MOCK',
    environment: 'TEST',
    credentialBindingId: 'binding_1',
    credentialVersionId: 'credential_version_1',
    requestIdempotencyKey: 'request_1',
    providerOrderRef: 'mock_order_obligation_1_attempt_1',
    outcomeStatus: 'PENDING',
    reviewStatus: 'NOT_REQUIRED',
    resolvedAt: null,
    lastOutcomeChangedAt: new Date(0),
    lastObservationAt: null,
    adapterVersion: 'mock-adapter-v1',
    mappingVersion: 'mock-mapping-v1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function cloneAttempt(attempt: PaymentAttempt): PaymentAttempt {
  return {
    ...attempt,
    lastOutcomeChangedAt: new Date(attempt.lastOutcomeChangedAt),
    lastObservationAt: attempt.lastObservationAt
      ? new Date(attempt.lastObservationAt)
      : null,
    createdAt: new Date(attempt.createdAt),
    updatedAt: new Date(attempt.updatedAt),
    resolvedAt: attempt.resolvedAt ? new Date(attempt.resolvedAt) : null,
  };
}

function virtualClock(initialEpochMs: number): VirtualClock {
  let nowMs = initialEpochMs;
  return {
    now() {
      return new Date(nowMs);
    },
    advanceBy(deltaMs: number) {
      nowMs += deltaMs;
    },
  };
}

function timeout() {
  return async (input: MockStatusQueryInput) =>
    mockAdapter.queryStatus({ ...input, scenario: 'TIMEOUT' });
}

function pending() {
  return async (input: MockStatusQueryInput) =>
    mockAdapter.queryStatus({ ...input, scenario: 'PENDING' });
}

function success() {
  return async (input: MockStatusQueryInput) =>
    mockAdapter.queryStatus({ ...input, scenario: 'SUCCESS' });
}

function deps(
  overrides: {
    attempt?: PaymentAttempt;
    persistedAttempt?: PaymentAttempt;
    clock?: VirtualClock;
    policy?: typeof MOCK_RECONCILIATION_POLICY_V1 | undefined;
    queryStatus?: ((input: MockStatusQueryInput) => Promise<RawObservationInput>) | undefined;
    reconciliationState?: DerivedReconciliationState;
    credentialUseInput?: Awaited<ReturnType<CredentialUseInputResolver>> | null;
    requestedReadOnlyQueries?: PendingReadOnlyQueryRequest[];
  } = {},
) {
  const listedAttempt = overrides.attempt ?? persistedAttempt();
  const storedAttempt = overrides.persistedAttempt ?? cloneAttempt(listedAttempt);
  const clock = overrides.clock ?? virtualClock(MOCK_RECONCILIATION_POLICY_V1.initialDelayMs);
  const state: DerivedReconciliationState = overrides.reconciliationState ?? {
    amountPaise: 10_000n,
    currency: 'INR',
    queryCount: 0,
    lastReconciledAt: null,
  };
  const history: PersistenceHistory = {
    outcomeTransitions: [],
    reviewHistory: [],
  };
  const listedSnapshots: PaymentAttempt[] = [];
  const calls = {
    getReconciliationState: [] as Array<[ReconciliationAttempt]>,
    queryStatus: [] as Array<[MockStatusQueryInput]>,
    ingestRawObservation: [] as Array<[RawObservationInput]>,
    persistSlaEscalation: [] as Array<[SlaEscalationRequest]>,
    buildCredentialUseInput: [] as Array<[ReconciliationAttempt]>,
    listRequestedReadOnlyQueries: [] as Array<[]>,
    claimReadOnlyQueryRequest: [] as Array<[PendingReadOnlyQueryRequest]>,
    persistReadOnlyQueryConsumption: [] as Array<[ReadOnlyQueryConsumptionRecord]>,
  };

  const defaultQueryStatus = overrides.queryStatus ?? timeout();
  const credentialUseInput = overrides.credentialUseInput === undefined
    ? {
        originalMerchantId: listedAttempt.merchantId,
        requestedMerchantId: listedAttempt.merchantId,
        originalProvider: listedAttempt.provider,
        requestedProvider: listedAttempt.provider,
        originalEnvironment: listedAttempt.environment,
        requestedEnvironment: listedAttempt.environment,
        originalBindingId: listedAttempt.credentialBindingId,
        requestedBindingId: listedAttempt.credentialBindingId,
        continuity: 'PROVEN_SAME_ACCOUNT' as const,
        credentialState: 'ACTIVE' as const,
        operation: 'STATUS_QUERY' as const,
      }
    : overrides.credentialUseInput;
  const baseDeps = {
    clock,
    getReconciliationState: async (attempt: ReconciliationAttempt) => {
      calls.getReconciliationState.push([attempt]);
      return state;
    },
    buildCredentialUseInput: async (attempt: ReconciliationAttempt) => {
      calls.buildCredentialUseInput.push([attempt]);
      return credentialUseInput;
    },
    queryStatus: async (input: MockStatusQueryInput) => {
      calls.queryStatus.push([input]);
      return defaultQueryStatus(input);
    },
    ingestRawObservation: async (input: RawObservationInput) => {
      calls.ingestRawObservation.push([input]);
      const parsed = mockAdapter.parse(input);
      state.queryCount += 1;
      state.lastReconciledAt = input.receivedAt;
      storedAttempt.lastObservationAt = input.receivedAt;

      if (parsed.mappedOutcome === 'SUCCEEDED') {
        history.outcomeTransitions.push({
          priorOutcomeStatus: storedAttempt.outcomeStatus,
          nextOutcomeStatus: 'SUCCEEDED',
        });
        storedAttempt.outcomeStatus = 'SUCCEEDED';
        storedAttempt.resolvedAt = parsed.providerOccurredAt;
      } else if (parsed.mappedOutcome === 'FAILED_TERMINAL') {
        history.outcomeTransitions.push({
          priorOutcomeStatus: storedAttempt.outcomeStatus,
          nextOutcomeStatus: 'FAILED_TERMINAL',
        });
        storedAttempt.outcomeStatus = 'FAILED_TERMINAL';
        storedAttempt.resolvedAt = parsed.providerOccurredAt;
      } else if (parsed.mappedOutcome === 'UNKNOWN') {
        if (storedAttempt.outcomeStatus !== 'UNKNOWN') {
          history.outcomeTransitions.push({
            priorOutcomeStatus: storedAttempt.outcomeStatus,
            nextOutcomeStatus: 'UNKNOWN',
          });
        }
        storedAttempt.outcomeStatus = 'UNKNOWN';
      }

      return {
        observationId: `observation_${state.queryCount}`,
        disposition: parsed.nativeStatus,
        outcomeStatus: storedAttempt.outcomeStatus,
        reviewStatus: storedAttempt.reviewStatus,
        resolvedAt: storedAttempt.resolvedAt,
      };
    },
    persistSlaEscalation: async (input: SlaEscalationRequest): Promise<SlaEscalationResult> => {
      calls.persistSlaEscalation.push([input]);
      if (
        storedAttempt.id !== input.attemptId ||
        storedAttempt.obligationId !== input.obligationId ||
        storedAttempt.merchantId !== input.merchantId ||
        storedAttempt.resolvedAt !== null
      ) {
        return { kind: 'NO_LONGER_UNRESOLVED' };
      }

      if (storedAttempt.outcomeStatus === 'PENDING') {
        history.outcomeTransitions.push({
          priorOutcomeStatus: storedAttempt.outcomeStatus,
          nextOutcomeStatus: 'UNKNOWN',
        });
        storedAttempt.outcomeStatus = 'UNKNOWN';
        storedAttempt.lastOutcomeChangedAt = input.observedAt;
      }

      if (storedAttempt.reviewStatus !== 'REQUIRED' && storedAttempt.reviewStatus !== 'IN_PROGRESS') {
        history.reviewHistory.push({
          priorReviewStatus: storedAttempt.reviewStatus,
          nextReviewStatus: 'REQUIRED',
          reasonCode: input.reason,
        });
        storedAttempt.reviewStatus = 'REQUIRED';
      }

      return {
        kind: 'ESCALATED',
        outcomeStatus: storedAttempt.outcomeStatus,
        reviewStatus: storedAttempt.reviewStatus,
      };
    },
    listRequestedReadOnlyQueries: async () => {
      calls.listRequestedReadOnlyQueries.push([]);
      return overrides.requestedReadOnlyQueries ?? [];
    },
    claimReadOnlyQueryRequest: async (request: PendingReadOnlyQueryRequest) => {
      calls.claimReadOnlyQueryRequest.push([request]);
      return request;
    },
    persistReadOnlyQueryConsumption: async (input: ReadOnlyQueryConsumptionRecord) => {
      calls.persistReadOnlyQueryConsumption.push([input]);
    },
    listUnresolvedAttempts: async () => {
      const snapshot = cloneAttempt(storedAttempt);
      listedSnapshots.push(snapshot);
      return [snapshot];
    },
  };

  const policyPart = 'policy' in overrides
    ? (overrides.policy === undefined ? {} : { policy: overrides.policy })
    : { policy: MOCK_RECONCILIATION_POLICY_V1 };
  const reconciliationDeps = {
    ...baseDeps,
    ...policyPart,
  } satisfies ReconciliationDeps & { listUnresolvedAttempts(): Promise<PaymentAttempt[]> };

  return {
    deps: reconciliationDeps,
    listedAttempt,
    storedAttempt,
    state,
    history,
    listedSnapshots,
    calls,
  };
}

describe('reconciliationWorker', () => {
  it('accepts the persisted Task 5 PaymentAttempt shape and derives query timing state', async () => {
    const attempt = persistedAttempt({
      lastObservationAt: new Date(10_000),
    });
    const { deps: rawDeps, calls } = deps({
      attempt,
      clock: virtualClock(15_000),
      reconciliationState: {
        amountPaise: 10_000n,
        currency: 'INR',
        queryCount: 1,
        lastReconciledAt: null,
      },
    });

    const result = await reconcileAttempt(rawDeps, attempt);

    assert.deepEqual(result, { kind: 'OBSERVATION_INGESTED', observationId: 'observation_2' });
    assert.equal(calls.getReconciliationState.length, 1);
    assert.equal(calls.queryStatus[0]?.[0].querySequence, 2);
    assert.equal(calls.queryStatus[0]?.[0].amountPaise, 10_000n);
    assert.equal(attempt.lastObservationAt?.getTime(), 10_000);
  });

  it('turns timeout into UNKNOWN through persisted observation state and preserves the lock', async () => {
    const attempt = persistedAttempt();
    const { deps: rawDeps, storedAttempt, calls } = deps({
      attempt,
      queryStatus: timeout(),
      clock: virtualClock(MOCK_RECONCILIATION_POLICY_V1.initialDelayMs),
    });

    await reconcileAttempt(rawDeps, attempt);

    assert.equal(storedAttempt.outcomeStatus, 'UNKNOWN');
    assert.equal(storedAttempt.resolvedAt, null);
    assert.equal(attempt.outcomeStatus, 'PENDING');
    assert.equal(calls.persistSlaEscalation.length, 0);
  });

  it('fails closed when the worker cannot resolve explicit credential policy input', async () => {
    const attempt = persistedAttempt();
    const { deps: rawDeps, calls } = deps({
      attempt,
      credentialUseInput: null,
    });

    const result = await reconcileAttempt(rawDeps, attempt);

    assert.deepEqual(result, {
      kind: 'QUERY_BLOCKED',
      reason: 'CREDENTIAL_CONTEXT_UNAVAILABLE',
    });
    assert.equal(calls.buildCredentialUseInput.length, 1);
    assert.equal(calls.queryStatus.length, 0);
  });

  it('consumes a durable read-only query request and bypasses not-due timing without mutating payment state itself', async () => {
    const attempt = persistedAttempt({
      reviewStatus: 'IN_PROGRESS',
      outcomeStatus: 'PENDING',
    });
    const { deps: rawDeps, storedAttempt, calls } = deps({
      attempt,
      clock: virtualClock(0),
      queryStatus: pending(),
      requestedReadOnlyQueries: [{
        requestId: 'review_query_1',
        attemptId: attempt.id,
        obligationId: attempt.obligationId,
        merchantId: attempt.merchantId,
        provider: attempt.provider,
        environment: attempt.environment,
        credentialBindingId: attempt.credentialBindingId,
        credentialVersionId: attempt.credentialVersionId,
        operation: 'STATUS_QUERY',
        note: 'await reconciler pass',
      }],
    });

    const [result] = await reconciliationWorker(rawDeps).runOnce();

    assert.deepEqual(result, {
      kind: 'OBSERVATION_INGESTED',
      observationId: 'observation_1',
    });
    assert.equal(calls.queryStatus.length, 1);
    assert.equal(calls.claimReadOnlyQueryRequest.length, 1);
    assert.equal(calls.queryStatus[0]?.[0].querySequence, 1);
    assert.equal(storedAttempt.outcomeStatus, 'PENDING');
    assert.equal(storedAttempt.reviewStatus, 'IN_PROGRESS');
    assert.equal(storedAttempt.resolvedAt, null);
    assert.equal(calls.persistReadOnlyQueryConsumption.length, 1);
    assert.deepEqual(calls.persistReadOnlyQueryConsumption[0]?.[0], {
      request: {
        requestId: 'review_query_1',
        attemptId: attempt.id,
        obligationId: attempt.obligationId,
        merchantId: attempt.merchantId,
        provider: attempt.provider,
        environment: attempt.environment,
        credentialBindingId: attempt.credentialBindingId,
        credentialVersionId: attempt.credentialVersionId,
        operation: 'STATUS_QUERY',
        note: 'await reconciler pass',
      },
      result: {
        kind: 'OBSERVATION_INGESTED',
        observationId: 'observation_1',
      },
    });
  });

  it('claims a durable read-only query request before execution so concurrent workers only query once', async () => {
    const attempt = persistedAttempt({
      reviewStatus: 'IN_PROGRESS',
      outcomeStatus: 'PENDING',
    });
    const request: PendingReadOnlyQueryRequest = {
      requestId: 'review_query_race',
      attemptId: attempt.id,
      obligationId: attempt.obligationId,
      merchantId: attempt.merchantId,
      provider: attempt.provider,
      environment: attempt.environment,
      credentialBindingId: attempt.credentialBindingId,
      credentialVersionId: attempt.credentialVersionId,
      operation: 'STATUS_QUERY',
      note: 'await single worker claim',
    };
    let claimReleased = false;
    let releaseClaimBarrier!: () => void;
    const claimBarrier = new Promise<void>((resolve) => {
      releaseClaimBarrier = resolve;
    });
    let alreadyClaimed = false;

    const { deps: rawDeps, calls } = deps({
      attempt,
      clock: virtualClock(0),
      queryStatus: pending(),
      requestedReadOnlyQueries: [request],
    });
    const worker = reconciliationWorker({
      ...rawDeps,
      claimReadOnlyQueryRequest: async (candidate: ClaimReadOnlyQueryRequest) => {
        calls.claimReadOnlyQueryRequest.push([candidate]);
        if (alreadyClaimed) {
          return null;
        }
        alreadyClaimed = true;
        if (!claimReleased) {
          claimReleased = true;
          await claimBarrier;
        }
        return candidate;
      },
    });

    const firstRun = worker.runOnce();
    await Promise.resolve();
    const secondRun = worker.runOnce();
    releaseClaimBarrier();

    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);

    assert.equal(calls.queryStatus.length, 1);
    assert.equal(calls.persistReadOnlyQueryConsumption.length, 1);
    assert.equal(calls.claimReadOnlyQueryRequest.length, 2);
    assert.deepEqual(firstResult, [{
      kind: 'OBSERVATION_INGESTED',
      observationId: 'observation_1',
    }]);
    assert.deepEqual(secondResult, [{
      kind: 'QUERY_BLOCKED',
      reason: 'READ_ONLY_QUERY_ALREADY_CLAIMED',
    }]);
  });

  it('routes SLA escalation through serialized persistence and does not mutate listed snapshots', async () => {
    const attempt = persistedAttempt();
    const clock = virtualClock(0);
    const { deps: rawDeps, storedAttempt, history, listedSnapshots, calls } = deps({
      attempt,
      clock,
      queryStatus: pending(),
    });
    const worker = reconciliationWorker(rawDeps);

    await worker.runOnce();
    clock.advanceBy(MOCK_RECONCILIATION_POLICY_V1.slaMs);
    await worker.runOnce();

    assert.equal(storedAttempt.outcomeStatus, 'UNKNOWN');
    assert.equal(storedAttempt.reviewStatus, 'REQUIRED');
    assert.equal(storedAttempt.resolvedAt, null);
    assert.deepEqual(history.outcomeTransitions, [
      { priorOutcomeStatus: 'PENDING', nextOutcomeStatus: 'UNKNOWN' },
    ]);
    assert.deepEqual(history.reviewHistory, [
      {
        priorReviewStatus: 'NOT_REQUIRED',
        nextReviewStatus: 'REQUIRED',
        reasonCode: 'SLA_EXCEEDED',
      },
    ]);
    assert.equal(calls.persistSlaEscalation.length, 1);
    assert.deepEqual(calls.persistSlaEscalation[0]?.[0], {
      attemptId: attempt.id,
      obligationId: attempt.obligationId,
      merchantId: attempt.merchantId,
      observedAt: new Date(MOCK_RECONCILIATION_POLICY_V1.slaMs),
      reason: 'SLA_EXCEEDED',
    });
    assert.equal(listedSnapshots[1]?.outcomeStatus, 'PENDING');
    assert.equal(listedSnapshots[1]?.reviewStatus, 'NOT_REQUIRED');
  });

  it('does not escalate a stale snapshot after the serialized query resolves the attempt', async () => {
    const attempt = persistedAttempt();
    const clock = virtualClock(MOCK_RECONCILIATION_POLICY_V1.slaMs);
    const { deps: rawDeps, storedAttempt, history, calls } = deps({
      attempt,
      clock,
      queryStatus: success(),
    });

    await reconciliationWorker(rawDeps).runOnce();

    assert.equal(storedAttempt.outcomeStatus, 'SUCCEEDED');
    assert.notEqual(storedAttempt.resolvedAt, null);
    assert.deepEqual(history.reviewHistory, []);
    assert.equal(calls.persistSlaEscalation.length, 1);
    assert.deepEqual(calls.persistSlaEscalation[0]?.[0].reason, 'SLA_EXCEEDED');
  });

  it('fails disabled when timing policy is absent', async () => {
    const attempt = persistedAttempt();
    const { deps: rawDeps, calls } = deps({
      attempt,
      policy: undefined,
    });

    assert.deepEqual(await reconcileAttempt(rawDeps, attempt), { kind: 'POLICY_DISABLED' });
    assert.equal(calls.queryStatus.length, 0);
  });

  for (const [name, policy] of [
    ['zero initial delay', { ...MOCK_RECONCILIATION_POLICY_V1, initialDelayMs: 0 }],
    ['cadence above max delay', { ...MOCK_RECONCILIATION_POLICY_V1, maxDelayMs: 4_999 }],
    ['sla below initial delay', { ...MOCK_RECONCILIATION_POLICY_V1, slaMs: 999 }],
    ['max automated below sla', { ...MOCK_RECONCILIATION_POLICY_V1, maxAutomatedQueryMs: 59_999 }],
    ['jitter outside range', { ...MOCK_RECONCILIATION_POLICY_V1, jitterBasisPoints: 10_001 }],
  ] as const) {
    it(`fails disabled for invalid policy: ${name}`, async () => {
      const attempt = persistedAttempt();
      const { deps: rawDeps, calls } = deps({
        attempt,
        policy,
        clock: virtualClock(MOCK_RECONCILIATION_POLICY_V1.initialDelayMs),
      });

      assert.deepEqual(await reconcileAttempt(rawDeps, attempt), { kind: 'POLICY_DISABLED' });
      assert.equal(calls.queryStatus.length, 0);
    });
  }

  it('returns not due before the initial reconciliation boundary', async () => {
    const attempt = persistedAttempt();
    const { deps: rawDeps, calls } = deps({
      attempt,
      clock: virtualClock(MOCK_RECONCILIATION_POLICY_V1.initialDelayMs - 1),
    });

    assert.deepEqual(await reconcileAttempt(rawDeps, attempt), { kind: 'NOT_DUE' });
    assert.equal(calls.queryStatus.length, 0);
  });
});
