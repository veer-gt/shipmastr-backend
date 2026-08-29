import type { PaymentAttempt } from '@prisma/client';
import type {
  MockStatusQueryInput,
  RawIngestionRejection,
  RawObservationInput,
  ReconciliationResult,
} from './adapters/providerAdapter.js';
import {
  decideCredentialUse,
  type CredentialUseInput,
} from './credentialPolicy.js';
import type {
  IngestionResult,
  OutcomeStatus,
  ProviderPolicyDecisionRecord,
  ReviewStatus,
} from './types.js';

export interface ReconciliationPolicy {
  version: string;
  approved: boolean;
  merchantId: string;
  provider: 'MOCK';
  environment: 'TEST';
  operation: 'STATUS_QUERY';
  approvedAt: Date;
  effectiveFrom: Date;
  effectiveUntil: Date;
  initialDelayMs: number;
  cadenceMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  jitterBasisPoints: number;
  slaMs: number;
  maxAutomatedQueryMs: number;
  evidenceHorizonMs: number;
}

export function createMockReconciliationPolicy(
  merchantId: string,
  overrides: Partial<ReconciliationPolicy> = {},
): Readonly<ReconciliationPolicy> {
  return Object.freeze({
    version: 'mock-reconciliation-v1',
    approved: true,
    merchantId,
    provider: 'MOCK',
    environment: 'TEST',
    operation: 'STATUS_QUERY',
    approvedAt: new Date(-1),
    effectiveFrom: new Date(0),
    effectiveUntil: new Date('2100-01-01T00:00:00.000Z'),
    initialDelayMs: 1_000,
    cadenceMs: 5_000,
    backoffMultiplier: 2,
    maxDelayMs: 30_000,
    jitterBasisPoints: 0,
    slaMs: 60_000,
    maxAutomatedQueryMs: 300_000,
    evidenceHorizonMs: 86_400_000,
    ...overrides,
  });
}

export const MOCK_RECONCILIATION_POLICY_V1 = createMockReconciliationPolicy('merchant_1');

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

export interface PendingReadOnlyQueryRequest {
  requestId: string;
  attemptId: string;
  obligationId: string;
  merchantId: string;
  provider: ReconciliationAttempt['provider'];
  environment: ReconciliationAttempt['environment'];
  credentialBindingId: string;
  credentialVersionId: string;
  operation: 'STATUS_QUERY';
  note: string | null;
}

export interface ReadOnlyQueryConsumptionRecord {
  request: PendingReadOnlyQueryRequest;
  result: ReconciliationResult;
}

export type ClaimReadOnlyQueryRequest = PendingReadOnlyQueryRequest;

export type CredentialUseInputResolver = (
  attempt: ReconciliationAttempt,
  request: PendingReadOnlyQueryRequest | null,
) => Promise<CredentialUseInput | null>;

export interface CredentialDenialPersistenceRequest {
  attemptId: string;
  obligationId: string;
  merchantId: string;
  observedAt: Date;
  reason:
    | 'CREDENTIAL_CONTEXT_UNAVAILABLE'
    | 'BINDING_MISMATCH'
    | 'CONTINUITY_NOT_PROVEN'
    | 'CREDENTIAL_NOT_ACTIVE'
    | 'OPERATION_NOT_ALLOWED';
  forceUnknownIfUnresolved: true;
  requireReview: true;
  preserveProviderLock: true;
  securityAlert: true;
}

export interface ReconciliationDeps {
  clock: Clock;
  policy?: ReconciliationPolicy;
  getReconciliationState(attempt: ReconciliationAttempt): Promise<DerivedReconciliationState>;
  queryStatus(input: MockStatusQueryInput): Promise<RawObservationInput>;
  ingestRawObservation(input: RawObservationInput): Promise<IngestionResult | RawIngestionRejection>;
  buildCredentialUseInput: CredentialUseInputResolver;
  persistCredentialDenial(input: CredentialDenialPersistenceRequest): Promise<void>;
  persistPolicyDecision(input: ProviderPolicyDecisionRecord): Promise<void>;
  persistSlaEscalation(input: SlaEscalationRequest): Promise<SlaEscalationResult>;
}

export interface ReconciliationWorkerDeps extends ReconciliationDeps {
  listUnresolvedAttempts(): Promise<ReconciliationAttempt[]>;
  listRequestedReadOnlyQueries?(): Promise<PendingReadOnlyQueryRequest[]>;
  claimReadOnlyQueryRequest?(request: ClaimReadOnlyQueryRequest): Promise<PendingReadOnlyQueryRequest | null>;
  persistReadOnlyQueryConsumption?(input: ReadOnlyQueryConsumptionRecord): Promise<void>;
}

export async function reconcileAttempt(
  deps: ReconciliationDeps,
  attempt: ReconciliationAttempt,
  request: PendingReadOnlyQueryRequest | null = null,
): Promise<ReconciliationResult> {
  const now = deps.clock.now();
  if (!isValidPolicy(deps.policy, attempt, now)) {
    await auditPolicyDecision(deps, attempt, now, 'DISABLED', 'POLICY_DISABLED');
    return { kind: 'POLICY_DISABLED' };
  }

  if (attempt.resolvedAt !== null) {
    await auditPolicyDecision(deps, attempt, now, 'NO_EXECUTION', 'ATTEMPT_RESOLVED');
    return { kind: 'QUERY_BLOCKED', reason: 'ATTEMPT_RESOLVED' };
  }

  const state = await deps.getReconciliationState(attempt);
  if (!isValidReconciliationState(state)) {
    await auditPolicyDecision(deps, attempt, now, 'NO_EXECUTION', 'RECONCILIATION_STATE_INVALID');
    return { kind: 'QUERY_BLOCKED', reason: 'RECONCILIATION_STATE_INVALID' };
  }

  const ageMs = now.getTime() - attempt.createdAt.getTime();
  if (ageMs > deps.policy.maxAutomatedQueryMs) {
    await auditPolicyDecision(deps, attempt, now, 'NO_EXECUTION', 'AUTOMATED_WINDOW_EXPIRED');
    return { kind: 'QUERY_BLOCKED', reason: 'AUTOMATED_WINDOW_EXPIRED' };
  }

  if (request === null && now.getTime() < nextDueAt(attempt, state, deps.policy).getTime()) {
    await auditPolicyDecision(deps, attempt, now, 'NO_EXECUTION', 'NOT_DUE');
    return { kind: 'NOT_DUE' };
  }

  let credentialInput: CredentialUseInput | null;
  try {
    credentialInput = await deps.buildCredentialUseInput(attempt, request);
  } catch {
    credentialInput = null;
  }
  if (!credentialInput) {
    await persistCredentialDenial(deps, attempt, now, 'CREDENTIAL_CONTEXT_UNAVAILABLE');
    await auditPolicyDecision(deps, attempt, now, 'NO_EXECUTION', 'CREDENTIAL_CONTEXT_UNAVAILABLE');
    return { kind: 'QUERY_BLOCKED', reason: 'CREDENTIAL_CONTEXT_UNAVAILABLE' };
  }

  const credentialDecision = decideCredentialUse(credentialInput);
  if (!credentialDecision.allowed) {
    await persistCredentialDenial(deps, attempt, now, credentialDecision.reason);
    await auditPolicyDecision(deps, attempt, now, 'NO_EXECUTION', credentialDecision.reason);
    return { kind: 'QUERY_BLOCKED', reason: credentialDecision.reason };
  }

  await auditPolicyDecision(deps, attempt, now, 'ENABLED', 'STATUS_QUERY_AUTHORIZED');

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

async function auditPolicyDecision(
  deps: ReconciliationDeps,
  attempt: ReconciliationAttempt,
  evaluatedAt: Date,
  decision: ProviderPolicyDecisionRecord['decision'],
  reason: string,
) {
  if (!deps.persistPolicyDecision) {
    throw new Error('POLICY_DECISION_AUDIT_UNAVAILABLE');
  }
  const policy = deps.policy;
  await deps.persistPolicyDecision({
    merchantId: attempt.merchantId,
    obligationId: attempt.obligationId,
    attemptId: attempt.id,
    provider: attempt.provider,
    environment: attempt.environment,
    operation: 'STATUS_QUERY',
    policyVersion: typeof policy?.version === 'string' ? policy.version : null,
    policyApproved: policy?.approved === true,
    policyMerchantId: typeof policy?.merchantId === 'string' ? policy.merchantId : null,
    policyProvider: isPaymentProvider(policy?.provider) ? policy.provider : null,
    policyEnvironment: isProviderEnvironment(policy?.environment) ? policy.environment : null,
    policyOperation: isProviderOperation(policy?.operation) ? policy.operation : null,
    maxAmountPaise: null,
    approvedAt: auditDate(policy?.approvedAt),
    effectiveFrom: auditDate(policy?.effectiveFrom),
    effectiveUntil: auditDate(policy?.effectiveUntil),
    evaluatedAt: auditDate(evaluatedAt) ?? new Date(),
    decision,
    reason,
    timing: policy ? {
      initialDelayMs: policy.initialDelayMs,
      cadenceMs: policy.cadenceMs,
      backoffMultiplier: policy.backoffMultiplier,
      maxDelayMs: policy.maxDelayMs,
      jitterBasisPoints: policy.jitterBasisPoints,
      slaMs: policy.slaMs,
      maxAutomatedQueryMs: policy.maxAutomatedQueryMs,
      evidenceHorizonMs: policy.evidenceHorizonMs,
    } : null,
  });
}

async function persistCredentialDenial(
  deps: ReconciliationDeps,
  attempt: ReconciliationAttempt,
  observedAt: Date,
  reason: CredentialDenialPersistenceRequest['reason'],
) {
  if (!deps.persistCredentialDenial) {
    throw new Error('CREDENTIAL_DENIAL_PERSISTENCE_UNAVAILABLE');
  }
  await deps.persistCredentialDenial({
    attemptId: attempt.id,
    obligationId: attempt.obligationId,
    merchantId: attempt.merchantId,
    observedAt,
    reason,
    forceUnknownIfUnresolved: true,
    requireReview: true,
    preserveProviderLock: true,
    securityAlert: true,
  });
}

export function reconciliationWorker(deps: ReconciliationWorkerDeps) {
  return {
    async runOnce(): Promise<ReconciliationResult[]> {
      const attempts = await deps.listUnresolvedAttempts();
      const pendingRequests = deps.listRequestedReadOnlyQueries
        ? await deps.listRequestedReadOnlyQueries()
        : [];
      const requestByAttemptId = new Map<string, PendingReadOnlyQueryRequest>();
      for (const request of pendingRequests) {
        if (!requestByAttemptId.has(request.attemptId)) {
          requestByAttemptId.set(request.attemptId, request);
        }
      }
      const results: ReconciliationResult[] = [];

      for (const attempt of attempts) {
        const pendingRequest = requestByAttemptId.get(attempt.id) ?? null;
        const claimReadOnlyQueryRequest = deps.claimReadOnlyQueryRequest;
        const persistReadOnlyQueryConsumption = deps.persistReadOnlyQueryConsumption;
        let claimedRequest: PendingReadOnlyQueryRequest | null = null;
        let result: ReconciliationResult;

        if (pendingRequest && !claimReadOnlyQueryRequest) {
          await auditPolicyDecision(
            deps,
            attempt,
            deps.clock.now(),
            'NO_EXECUTION',
            'READ_ONLY_QUERY_CLAIM_UNAVAILABLE',
          );
          result = { kind: 'QUERY_BLOCKED', reason: 'READ_ONLY_QUERY_CLAIM_UNAVAILABLE' };
        } else if (pendingRequest && !persistReadOnlyQueryConsumption) {
          await auditPolicyDecision(
            deps,
            attempt,
            deps.clock.now(),
            'NO_EXECUTION',
            'READ_ONLY_QUERY_CONSUMPTION_UNAVAILABLE',
          );
          result = { kind: 'QUERY_BLOCKED', reason: 'READ_ONLY_QUERY_CONSUMPTION_UNAVAILABLE' };
        } else if (pendingRequest) {
          claimedRequest = await claimReadOnlyQueryRequest!(pendingRequest);
          if (claimedRequest) {
            result = await reconcileAttempt(deps, attempt, claimedRequest);
          } else {
            await auditPolicyDecision(
              deps,
              attempt,
              deps.clock.now(),
              'NO_EXECUTION',
              'READ_ONLY_QUERY_ALREADY_CLAIMED',
            );
            result = { kind: 'QUERY_BLOCKED', reason: 'READ_ONLY_QUERY_ALREADY_CLAIMED' };
          }
        } else {
          result = await reconcileAttempt(deps, attempt, null);
        }
        results.push(result);

        if (claimedRequest && persistReadOnlyQueryConsumption) {
          await persistReadOnlyQueryConsumption({
            request: claimedRequest,
            result,
          });
        }

        if (
          isValidPolicy(deps.policy, attempt, deps.clock.now()) &&
          isSlaBreached(deps.clock, deps.policy, attempt)
        ) {
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

function isValidPolicy(
  policy: ReconciliationPolicy | undefined,
  attempt: ReconciliationAttempt,
  evaluatedAt: Date,
): policy is ReconciliationPolicy {
  if (!policy) {
    return false;
  }

  if (
    policy.approved !== true ||
    typeof policy.version !== 'string' ||
    policy.version.trim() === '' ||
    attempt.provider !== 'MOCK' ||
    attempt.environment !== 'TEST' ||
    policy.merchantId !== attempt.merchantId ||
    policy.provider !== attempt.provider ||
    policy.environment !== attempt.environment ||
    policy.operation !== 'STATUS_QUERY' ||
    !validDate(policy.approvedAt) ||
    !validDate(policy.effectiveFrom) ||
    !validDate(policy.effectiveUntil) ||
    !validDate(evaluatedAt) ||
    policy.approvedAt.getTime() > policy.effectiveFrom.getTime() ||
    evaluatedAt.getTime() < policy.effectiveFrom.getTime() ||
    evaluatedAt.getTime() >= policy.effectiveUntil.getTime()
  ) {
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

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function auditDate(value: unknown): Date | null {
  return validDate(value) ? value : null;
}

function isPaymentProvider(value: unknown): value is 'MOCK' | 'CASHFREE' | 'PAYTM' {
  return value === 'MOCK' || value === 'CASHFREE' || value === 'PAYTM';
}

function isProviderEnvironment(value: unknown): value is 'TEST' | 'LIVE' {
  return value === 'TEST' || value === 'LIVE';
}

function isProviderOperation(value: unknown): value is NonNullable<ProviderPolicyDecisionRecord['policyOperation']> {
  return value === 'CREATE_ATTEMPT' || value === 'STATUS_QUERY';
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
