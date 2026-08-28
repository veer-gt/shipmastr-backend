import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MOCK_RECONCILIATION_POLICY_V1,
  reconcileAttempt,
  reconciliationWorker,
} from '../reconciliationWorker.js';
import { mockAdapter } from '../adapters/mockAdapter.js';
import type {
  MockCreateInput,
  MockStatusQueryInput,
  RawObservationInput,
} from '../adapters/providerAdapter.js';
import type { OutcomeStatus, ReviewStatus } from '../types.js';

interface MutableAttempt {
  id: string;
  obligationId: string;
  merchantId: string;
  provider: 'MOCK';
  environment: 'TEST';
  credentialBindingId: string;
  credentialVersionId: string;
  amountPaise: bigint;
  currency: 'INR';
  scenario: MockCreateInput['scenario'];
  createdAt: Date;
  resolvedAt: Date | null;
  lastObservedAt: Date | null;
  lastReconciledAt: Date | null;
  queryCount: number;
  outcomeStatus: OutcomeStatus;
  reviewStatus: ReviewStatus;
}

function unresolvedAttempt(
  overrides: Partial<MutableAttempt> = {},
): MutableAttempt {
  return {
    id: 'attempt_1',
    obligationId: 'obligation_1',
    merchantId: 'merchant_1',
    provider: 'MOCK',
    environment: 'TEST',
    credentialBindingId: 'binding_1',
    credentialVersionId: 'credential_version_1',
    amountPaise: 10_000n,
    currency: 'INR',
    scenario: 'TIMEOUT',
    createdAt: new Date(0),
    resolvedAt: null,
    lastObservedAt: null,
    lastReconciledAt: null,
    queryCount: 0,
    outcomeStatus: 'PENDING',
    reviewStatus: 'NOT_REQUIRED',
    ...overrides,
  };
}

function virtualClock(initialEpochMs: number) {
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

function deps(
  overrides: Parameters<typeof buildDeps>[0] = {},
) {
  return buildDeps(overrides);
}

function buildDeps(
  overrides: {
    attempt?: MutableAttempt;
    clock?: ReturnType<typeof virtualClock>;
    policy?: typeof MOCK_RECONCILIATION_POLICY_V1 | undefined;
    queryStatus?: ((input: MockStatusQueryInput) => Promise<RawObservationInput>) | undefined;
  } = {},
) {
  const attempt = overrides.attempt ?? unresolvedAttempt();
  const clock = overrides.clock ?? virtualClock(MOCK_RECONCILIATION_POLICY_V1.initialDelayMs);
  const calls = {
    queryStatus: [] as Array<[MockStatusQueryInput]>,
    ingestRawObservation: [] as Array<[RawObservationInput]>,
  };
  const baseDeps = {
    clock,
    decideCredentialUse: () => ({ allowed: true as const, operation: 'STATUS_QUERY' as const }),
    queryStatus: overrides.queryStatus ?? (async (input: MockStatusQueryInput) => {
      calls.queryStatus.push([input]);
      return mockAdapter.queryStatus({ ...input, scenario: attempt.scenario });
    }),
    ingestRawObservation: async (input: RawObservationInput) => {
      calls.ingestRawObservation.push([input]);
      const parsed = mockAdapter.parse(input);
      attempt.lastObservedAt = input.receivedAt;
      attempt.lastReconciledAt = input.receivedAt;
      attempt.queryCount += 1;
      if (parsed.mappedOutcome === 'SUCCEEDED') {
        attempt.outcomeStatus = 'SUCCEEDED';
        attempt.resolvedAt = parsed.providerOccurredAt;
      } else if (parsed.mappedOutcome === 'FAILED_TERMINAL') {
        attempt.outcomeStatus = 'FAILED_TERMINAL';
        attempt.resolvedAt = parsed.providerOccurredAt;
      } else if (parsed.mappedOutcome === 'PENDING') {
        attempt.outcomeStatus = 'PENDING';
      } else if (parsed.mappedOutcome === 'UNKNOWN') {
        attempt.outcomeStatus = 'UNKNOWN';
      }

      return {
        observationId: `observation_${attempt.queryCount}`,
        disposition: parsed.nativeStatus,
        outcomeStatus: attempt.outcomeStatus,
        reviewStatus: attempt.reviewStatus,
        resolvedAt: attempt.resolvedAt,
      };
    },
    listUnresolvedAttempts: async () => [attempt],
  };
  const policyPart = 'policy' in overrides
    ? (overrides.policy === undefined ? {} : { policy: overrides.policy })
    : { policy: MOCK_RECONCILIATION_POLICY_V1 };
  const deps = {
    ...baseDeps,
    ...policyPart,
  };

  return {
    deps,
    attempt,
    calls,
  };
}

async function currentAttempt(attempt: MutableAttempt) {
  return { ...attempt };
}

describe('reconciliationWorker', () => {
  it('turns timeout into UNKNOWN and preserves the lock', async () => {
    const attempt = unresolvedAttempt();
    const { deps: rawDeps } = deps({
      attempt,
      queryStatus: timeout(),
      clock: virtualClock(MOCK_RECONCILIATION_POLICY_V1.initialDelayMs),
      policy: MOCK_RECONCILIATION_POLICY_V1,
    });

    await reconcileAttempt(rawDeps, attempt);

    assert.partialDeepStrictEqual(await currentAttempt(attempt), {
      outcomeStatus: 'UNKNOWN',
      resolvedAt: null,
    });
    assert.equal(Object.keys(rawDeps).includes('createAlternateProvider'), false);
  });

  it('escalates on SLA without replay or fallback', async () => {
    const attempt = unresolvedAttempt();
    const clock = virtualClock(0);
    const { deps: rawDeps } = deps({
      attempt,
      clock,
      policy: MOCK_RECONCILIATION_POLICY_V1,
    });
    const worker = reconciliationWorker(rawDeps);

    await worker.runOnce();
    clock.advanceBy(MOCK_RECONCILIATION_POLICY_V1.slaMs);
    await worker.runOnce();

    assert.partialDeepStrictEqual(await currentAttempt(attempt), {
      outcomeStatus: 'UNKNOWN',
      reviewStatus: 'REQUIRED',
      resolvedAt: null,
    });
    assert.equal(Object.keys(rawDeps).includes('createAlternateProvider'), false);
  });

  it('fails disabled when timing policy is absent', async () => {
    const attempt = unresolvedAttempt();
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
      const attempt = unresolvedAttempt();
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
    const attempt = unresolvedAttempt();
    const { deps: rawDeps, calls } = deps({
      attempt,
      clock: virtualClock(MOCK_RECONCILIATION_POLICY_V1.initialDelayMs - 1),
      policy: MOCK_RECONCILIATION_POLICY_V1,
    });

    assert.deepEqual(await reconcileAttempt(rawDeps, attempt), { kind: 'NOT_DUE' });
    assert.equal(calls.queryStatus.length, 0);
  });
});
