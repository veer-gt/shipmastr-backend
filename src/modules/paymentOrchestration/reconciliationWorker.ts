import type {
  MockStatusQueryInput,
  RawIngestionRejection,
  RawObservationInput,
  ReconciliationResult,
} from './adapters/providerAdapter.js';
import type { IngestionResult, OutcomeStatus, ReviewStatus } from './types.js';

export interface ReconciliationPolicy {
  version: string;
  initialDelayMs: number;
  cadenceMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  jitterBasisPoints: number;
  slaMs: number;
  maxAutomatedQueryMs: number;
  evidenceHorizonMs: number;
}

export const MOCK_RECONCILIATION_POLICY_V1: Readonly<ReconciliationPolicy> = Object.freeze({
  version: 'mock-reconciliation-v1',
  initialDelayMs: 1_000,
  cadenceMs: 5_000,
  backoffMultiplier: 2,
  maxDelayMs: 30_000,
  jitterBasisPoints: 0,
  slaMs: 60_000,
  maxAutomatedQueryMs: 300_000,
  evidenceHorizonMs: 86_400_000,
});

export interface Clock {
  now(): Date;
}

export interface ReconciliationAttempt {
  id: string;
  obligationId: string;
  merchantId: string;
  provider: 'MOCK';
  environment: 'TEST' | 'LIVE';
  credentialBindingId: string;
  credentialVersionId: string;
  amountPaise: bigint;
  currency: 'INR';
  createdAt: Date;
  resolvedAt: Date | null;
  lastObservedAt: Date | null;
  lastReconciledAt: Date | null;
  queryCount: number;
  outcomeStatus: OutcomeStatus;
  reviewStatus: ReviewStatus;
  scenario?: MockStatusQueryInput['scenario'];
}

export interface ReconciliationDeps {
  clock: Clock;
  policy?: ReconciliationPolicy;
  queryStatus(input: MockStatusQueryInput): Promise<RawObservationInput>;
  ingestRawObservation(input: RawObservationInput): Promise<IngestionResult | RawIngestionRejection>;
  decideCredentialUse(): { allowed: true; operation: 'STATUS_QUERY' } | { allowed: false; reason: string };
}

export interface ReconciliationWorkerDeps extends ReconciliationDeps {
  listUnresolvedAttempts(): Promise<ReconciliationAttempt[]>;
}

export async function reconcileAttempt(
  deps: ReconciliationDeps,
  attempt: ReconciliationAttempt,
): Promise<ReconciliationResult> {
  if (!isValidPolicy(deps.policy)) {
    return { kind: 'POLICY_DISABLED' };
  }

  if (attempt.provider !== 'MOCK') {
    return { kind: 'QUERY_BLOCKED', reason: 'PROVIDER_NOT_EXECUTABLE' };
  }

  if (attempt.resolvedAt !== null) {
    return { kind: 'QUERY_BLOCKED', reason: 'ATTEMPT_RESOLVED' };
  }

  const ageMs = deps.clock.now().getTime() - attempt.createdAt.getTime();
  if (ageMs > deps.policy.maxAutomatedQueryMs) {
    return { kind: 'QUERY_BLOCKED', reason: 'AUTOMATED_WINDOW_EXPIRED' };
  }

  if (deps.clock.now().getTime() < nextDueAt(attempt, deps.policy).getTime()) {
    return { kind: 'NOT_DUE' };
  }

  const credentialDecision = deps.decideCredentialUse();
  if (!credentialDecision.allowed) {
    return { kind: 'QUERY_BLOCKED', reason: credentialDecision.reason };
  }

  const raw = await deps.queryStatus({
    attemptId: attempt.id,
    obligationId: attempt.obligationId,
    merchantId: attempt.merchantId,
    amountPaise: attempt.amountPaise,
    currency: attempt.currency,
    scenario: attempt.scenario ?? 'TIMEOUT',
    querySequence: attempt.queryCount + 1,
  });
  const result = await deps.ingestRawObservation(raw);
  if ('kind' in result) {
    return { kind: 'QUERY_BLOCKED', reason: result.reason };
  }

  return {
    kind: 'OBSERVATION_INGESTED',
    observationId: result.observationId,
  };
}

export function reconciliationWorker(deps: ReconciliationWorkerDeps) {
  return {
    async runOnce(): Promise<ReconciliationResult[]> {
      const attempts = await deps.listUnresolvedAttempts();
      const results: ReconciliationResult[] = [];

      for (const attempt of attempts) {
        const result = await reconcileAttempt(deps, attempt);
        results.push(result);

        if (isValidPolicy(deps.policy) && isSlaBreached(deps.clock, deps.policy, attempt) && attempt.resolvedAt === null) {
          if (attempt.outcomeStatus === 'PENDING') {
            attempt.outcomeStatus = 'UNKNOWN';
          }
          attempt.reviewStatus = escalateReviewStatus(attempt.reviewStatus);
        }
      }

      return results;
    },
  };
}

function nextDueAt(attempt: ReconciliationAttempt, policy: ReconciliationPolicy): Date {
  if (attempt.queryCount <= 0) {
    return new Date(attempt.createdAt.getTime() + policy.initialDelayMs);
  }

  const base = attempt.lastReconciledAt ?? attempt.lastObservedAt ?? attempt.createdAt;
  let delayMs = policy.cadenceMs;
  for (let index = 1; index < attempt.queryCount; index += 1) {
    delayMs = Math.min(policy.maxDelayMs, Math.floor(delayMs * policy.backoffMultiplier));
  }
  return new Date(base.getTime() + delayMs);
}

function isSlaBreached(clock: Clock, policy: ReconciliationPolicy, attempt: ReconciliationAttempt): boolean {
  return clock.now().getTime() - attempt.createdAt.getTime() >= policy.slaMs;
}

function isValidPolicy(policy: ReconciliationPolicy | undefined): policy is ReconciliationPolicy {
  if (!policy) {
    return false;
  }

  const fields = [
    policy.initialDelayMs,
    policy.cadenceMs,
    policy.backoffMultiplier,
    policy.maxDelayMs,
    policy.jitterBasisPoints,
    policy.slaMs,
    policy.maxAutomatedQueryMs,
    policy.evidenceHorizonMs,
  ];

  if (!fields.every((value) => Number.isSafeInteger(value) && Number.isFinite(value))) {
    return false;
  }

  if (policy.initialDelayMs <= 0 || policy.cadenceMs <= 0 || policy.backoffMultiplier < 1) {
    return false;
  }

  if (policy.maxDelayMs < policy.cadenceMs) {
    return false;
  }

  if (policy.slaMs < policy.initialDelayMs) {
    return false;
  }

  if (policy.maxAutomatedQueryMs < policy.slaMs) {
    return false;
  }

  if (policy.evidenceHorizonMs < policy.maxAutomatedQueryMs) {
    return false;
  }

  if (policy.jitterBasisPoints < 0 || policy.jitterBasisPoints > 10_000) {
    return false;
  }

  return true;
}

function escalateReviewStatus(reviewStatus: ReviewStatus): ReviewStatus {
  if (reviewStatus === 'IN_PROGRESS') {
    return 'IN_PROGRESS';
  }

  return 'REQUIRED';
}
