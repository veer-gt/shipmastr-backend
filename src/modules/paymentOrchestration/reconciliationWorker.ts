import type { PaymentAttempt } from '@prisma/client';
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

export type ReconciliationAttempt = Pick<
  PaymentAttempt,
  | 'id'
  | 'obligationId'
  | 'merchantId'
  | 'provider'
  | 'environment'
  | 'credentialBindingId'
  | 'credentialVersionId'
  | 'createdAt'
  | 'resolvedAt'
  | 'lastObservationAt'
  | 'outcomeStatus'
  | 'reviewStatus'
>;

export interface DerivedReconciliationState {
  amountPaise: bigint;
  currency: 'INR';
  queryCount: number;
  lastReconciledAt: Date | null;
}

export interface SlaEscalationRequest {
  attemptId: string;
  obligationId: string;
  merchantId: string;
  observedAt: Date;
  reason: 'SLA_EXCEEDED';
}

export type SlaEscalationResult =
  | {
      kind: 'ESCALATED';
      outcomeStatus: OutcomeStatus;
      reviewStatus: ReviewStatus;
    }
  | { kind: 'NO_LONGER_UNRESOLVED' };

export interface ReconciliationDeps {
  clock: Clock;
  policy?: ReconciliationPolicy;
  getReconciliationState(attempt: ReconciliationAttempt): Promise<DerivedReconciliationState>;
  queryStatus(input: MockStatusQueryInput): Promise<RawObservationInput>;
  ingestRawObservation(input: RawObservationInput): Promise<IngestionResult | RawIngestionRejection>;
  decideCredentialUse(): { allowed: true; operation: 'STATUS_QUERY' } | { allowed: false; reason: string };
  persistSlaEscalation(input: SlaEscalationRequest): Promise<SlaEscalationResult>;
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

  const now = deps.clock.now();
  const state = await deps.getReconciliationState(attempt);
  if (!isValidReconciliationState(state)) {
    return { kind: 'QUERY_BLOCKED', reason: 'RECONCILIATION_STATE_INVALID' };
  }

  const ageMs = now.getTime() - attempt.createdAt.getTime();
  if (ageMs > deps.policy.maxAutomatedQueryMs) {
    return { kind: 'QUERY_BLOCKED', reason: 'AUTOMATED_WINDOW_EXPIRED' };
  }

  if (now.getTime() < nextDueAt(attempt, state, deps.policy).getTime()) {
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
    amountPaise: state.amountPaise,
    currency: state.currency,
    scenario: 'TIMEOUT',
    querySequence: state.queryCount + 1,
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

        if (isValidPolicy(deps.policy) && isSlaBreached(deps.clock, deps.policy, attempt)) {
          await deps.persistSlaEscalation({
            attemptId: attempt.id,
            obligationId: attempt.obligationId,
            merchantId: attempt.merchantId,
            observedAt: deps.clock.now(),
            reason: 'SLA_EXCEEDED',
          });
        }
      }

      return results;
    },
  };
}

function nextDueAt(
  attempt: ReconciliationAttempt,
  state: DerivedReconciliationState,
  policy: ReconciliationPolicy,
): Date {
  if (state.queryCount <= 0) {
    return new Date(attempt.createdAt.getTime() + policy.initialDelayMs);
  }

  const base = state.lastReconciledAt ?? attempt.lastObservationAt ?? attempt.createdAt;
  let delayMs = policy.cadenceMs;
  for (let index = 1; index < state.queryCount; index += 1) {
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

function isValidReconciliationState(
  state: DerivedReconciliationState,
): state is DerivedReconciliationState {
  return (
    typeof state.amountPaise === 'bigint' &&
    state.amountPaise > 0n &&
    state.currency === 'INR' &&
    Number.isSafeInteger(state.queryCount) &&
    state.queryCount >= 0 &&
    (state.lastReconciledAt === null || state.lastReconciledAt instanceof Date)
  );
}
