import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { PrismaClient } from '@prisma/client';
import {
  ingestObservation,
  persistCredentialUseDenial,
  persistProviderSecurityRejection,
  persistSlaEscalation,
} from '../observationService.js';
import { ingestRawObservation } from '../observationIngestor.js';
import {
  createMockReconciliationPolicy,
  reconciliationWorker,
  type CredentialUseInputResolver,
  type Clock,
  type DerivedReconciliationState,
  type PendingReadOnlyQueryRequest,
  type ReadOnlyQueryConsumptionRecord,
} from '../reconciliationWorker.js';
import { mockAdapter, mockProviderOrderRef } from '../adapters/mockAdapter.js';
import type { MockStatusQueryInput } from '../adapters/providerAdapter.js';
import { persistProviderPolicyDecision } from '../policyAudit.js';
import { claimReview, requestReadOnlyQuery } from '../reviewService.js';
import { expectedScratchDatabaseNameFromEnv } from './scratchDatabaseGuard.js';
import { createPaymentPostgresNamespace } from './postgresTestNamespace.js';

const enabled = process.env.RUN_PGO1_POSTGRES_TESTS === '1';
const prisma = new PrismaClient();
const namespace = createPaymentPostgresNamespace('reconciliation_worker');

interface MutableClock extends Clock {
  advanceBy(deltaMs: number): void;
}

function virtualClock(initialEpochMs: number): MutableClock {
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

function decodeReviewPayload(value: unknown): { references: string[]; note: string | null } {
  if (Array.isArray(value)) {
    return {
      references: value.filter((entry): entry is string => typeof entry === 'string'),
      note: null,
    };
  }
  if (!value || typeof value !== 'object') {
    return { references: [], note: null };
  }

  const record = value as { references?: unknown; note?: unknown };
  return {
    references: Array.isArray(record.references)
      ? record.references.filter((entry): entry is string => typeof entry === 'string')
      : [],
    note: typeof record.note === 'string' ? record.note : null,
  };
}

async function listPendingReadOnlyQueryRequests(): Promise<PendingReadOnlyQueryRequest[]> {
  const rows = await prisma.reconciliationReviewHistory.findMany({
    where: {
      merchantId: { startsWith: namespace.prefix },
      reasonCode: 'READ_ONLY_QUERY_REQUESTED',
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const pending: PendingReadOnlyQueryRequest[] = [];
  for (const row of rows) {
    if (!row.correlationId) {
      continue;
    }

    const claimedOrConsumed = await prisma.reconciliationReviewHistory.findFirst({
      where: {
        attemptId: row.attemptId,
        merchantId: row.merchantId,
        reasonCode: {
          in: ['READ_ONLY_QUERY_CLAIMED', 'READ_ONLY_QUERY_CONSUMED'],
        },
        correlationId: row.correlationId,
      },
      select: { id: true },
    });
    if (claimedOrConsumed) {
      continue;
    }

    const attempt = await prisma.paymentAttempt.findUnique({
      where: { id: row.attemptId },
    });
    if (!attempt) {
      continue;
    }

    const payload = decodeReviewPayload(row.evidenceReferenceIds);
    pending.push({
      requestId: row.correlationId,
      attemptId: row.attemptId,
      obligationId: row.obligationId,
      merchantId: row.merchantId,
      provider: attempt.provider,
      environment: attempt.environment,
      credentialBindingId: attempt.credentialBindingId,
      credentialVersionId: attempt.credentialVersionId,
      operation: 'STATUS_QUERY',
      note: payload.note,
    });
  }

  return pending;
}

async function claimReadOnlyQueryRequest(
  request: PendingReadOnlyQueryRequest,
): Promise<PendingReadOnlyQueryRequest | null> {
  return prisma.$transaction(async (tx) => {
    const lockedRequestRows = await tx.$queryRaw<Array<{
      id: string;
      evidenceReferenceIds: unknown;
    }>>`
      SELECT "id", "evidenceReferenceIds"
      FROM "ReconciliationReviewHistory"
      WHERE "attemptId" = ${request.attemptId}
        AND "obligationId" = ${request.obligationId}
        AND "merchantId" = ${request.merchantId}
        AND "reasonCode" = 'READ_ONLY_QUERY_REQUESTED'
        AND "correlationId" = ${request.requestId}
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT 1
      FOR UPDATE
    `;

    if (lockedRequestRows.length !== 1) {
      return null;
    }

    const priorClaim = await tx.reconciliationReviewHistory.findFirst({
      where: {
        attemptId: request.attemptId,
        obligationId: request.obligationId,
        merchantId: request.merchantId,
        reasonCode: {
          in: ['READ_ONLY_QUERY_CLAIMED', 'READ_ONLY_QUERY_CONSUMED'],
        },
        correlationId: request.requestId,
      },
      select: { id: true },
    });
    if (priorClaim) {
      return null;
    }

    const attempt = await tx.paymentAttempt.findFirst({
      where: {
        id: request.attemptId,
        obligationId: request.obligationId,
        merchantId: request.merchantId,
      },
    });
    if (!attempt) {
      return null;
    }

    const payload = decodeReviewPayload(lockedRequestRows[0]?.evidenceReferenceIds);
    await tx.reconciliationReviewHistory.create({
      data: {
        attemptId: attempt.id,
        obligationId: attempt.obligationId,
        merchantId: attempt.merchantId,
        priorReviewStatus: attempt.reviewStatus,
        nextReviewStatus: attempt.reviewStatus,
        completedByType: null,
        actorId: null,
        reasonCode: 'READ_ONLY_QUERY_CLAIMED',
        triggeringObservationId: null,
        evidenceReferenceIds: {
          references: payload.references,
          note: payload.note,
        },
        correlationId: request.requestId,
      },
    });

    return {
      ...request,
      note: payload.note,
    };
  });
}

async function persistReadOnlyQueryConsumption(
  input: ReadOnlyQueryConsumptionRecord,
) {
  await prisma.$transaction(async (tx) => {
    const attempt = await tx.paymentAttempt.findFirst({
      where: {
        id: input.request.attemptId,
        obligationId: input.request.obligationId,
        merchantId: input.request.merchantId,
      },
    });
    if (!attempt) {
      throw new Error('ATTEMPT_NOT_FOUND');
    }

    await tx.reconciliationReviewHistory.create({
      data: {
        attemptId: attempt.id,
        obligationId: attempt.obligationId,
        merchantId: attempt.merchantId,
        priorReviewStatus: attempt.reviewStatus,
        nextReviewStatus: attempt.reviewStatus,
        completedByType: null,
        actorId: null,
        reasonCode: 'READ_ONLY_QUERY_CONSUMED',
        triggeringObservationId: null,
        evidenceReferenceIds: {
          references: [],
          note: input.request.note,
          result: input.result.kind,
        },
        correlationId: input.request.requestId,
      },
    });
  });
}

function assertScratchUrl() {
  const raw = process.env.DATABASE_URL ?? '';
  const url = new URL(raw);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname.toLowerCase()));
  assert.equal(url.port, '5433');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), expectedScratchDatabaseNameFromEnv());
}

if (enabled) {
  describe('reconciliationWorker PostgreSQL integration', () => {
    before(async () => {
      assertScratchUrl();
      const current = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
      assert.equal(current[0]?.name, expectedScratchDatabaseNameFromEnv());
    });

    beforeEach(async () => {
      await namespace.assertEmpty(prisma);
    });

    afterEach(async () => {
      await namespace.cleanup(prisma);
    });

    after(async () => {
      await prisma.$disconnect();
    });

    it('uses the persisted attempt shape and routes worker SLA escalation through Task 5 persistence', async () => {
      const clock = virtualClock(0);
      const merchantId = namespace.id('merchant_worker_integration');
      const policy = createMockReconciliationPolicy(merchantId);
      const obligationId = namespace.id('obligation_worker_integration');
      const attemptId = namespace.id('attempt_worker_integration');
      const obligation = await prisma.paymentObligation.create({
        data: {
          id: obligationId,
          merchantId,
          checkoutId: namespace.id('checkout_worker_integration'),
          collectionRail: 'ONLINE',
          purpose: 'FULL_ONLINE',
          amountPaise: 10_000n,
          currency: 'INR',
          status: 'OPEN',
          satisfiedAt: null,
        },
      });
      await prisma.paymentAttempt.create({
        data: {
          id: attemptId,
          obligationId: obligation.id,
          merchantId,
          obligationCollectionRail: obligation.collectionRail,
          provider: 'MOCK',
          environment: 'TEST',
          credentialBindingId: namespace.id('binding_worker_integration'),
          credentialVersionId: namespace.id('credential_worker_integration'),
          requestIdempotencyKey: namespace.id('request_worker_integration'),
          providerOrderRef: mockProviderOrderRef(obligationId, attemptId),
          outcomeStatus: 'PENDING',
          reviewStatus: 'NOT_REQUIRED',
          resolvedAt: null,
          lastOutcomeChangedAt: new Date(0),
          lastObservationAt: null,
          adapterVersion: 'mock-adapter-v1',
          mappingVersion: 'mock-mapping-v1',
          createdAt: new Date(0),
        },
      });

      const worker = reconciliationWorker({
        clock,
        policy,
        getReconciliationState: async (): Promise<DerivedReconciliationState> => {
          const observations = await prisma.providerObservation.findMany({
            where: { attemptId },
            orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
            select: { receivedAt: true },
          });
          return {
            amountPaise: obligation.amountPaise,
            currency: obligation.currency as 'INR',
            queryCount: observations.length,
            lastReconciledAt: observations[0]?.receivedAt ?? null,
          };
        },
        queryStatus: async (input: MockStatusQueryInput) => {
          const raw = await mockAdapter.queryStatus({ ...input, scenario: 'PENDING' });
          return { ...raw, receivedAt: clock.now() };
        },
        ingestRawObservation: (input) => ingestRawObservation({
          parser: mockAdapter,
          ingestionMode: 'MOCK_EXECUTABLE',
          retentionDecision: 'MOCK_SYNTHETIC',
          environment: 'TEST',
          source: 'MOCK',
          securityContext: { merchantId, obligationId, attemptId, credentialBindingId: namespace.id('binding_worker_integration') },
          nextObservationId: () => namespace.id('observation_worker_integration'),
          resolveBinding: async () => ({
            attemptId,
            obligationId,
            merchantId,
            credentialBindingId: namespace.id('binding_worker_integration'),
            credentialVersionId: namespace.id('credential_worker_integration'),
            bindingVerification: 'VERIFIED' as const,
          }),
          verify: async () => 'NOT_APPLICABLE' as const,
          persistSecurityRejection: (evidence) => persistProviderSecurityRejection(prisma, evidence),
          persist: (candidate) => ingestObservation(prisma, candidate),
        }, input),
        buildCredentialUseInput: async (attempt) => ({
          originalMerchantId: attempt.merchantId,
          requestedMerchantId: attempt.merchantId,
          originalProvider: attempt.provider,
          requestedProvider: attempt.provider,
          originalEnvironment: attempt.environment,
          requestedEnvironment: attempt.environment,
          originalBindingId: attempt.credentialBindingId,
          requestedBindingId: attempt.credentialBindingId,
          continuity: 'PROVEN_SAME_ACCOUNT',
          credentialState: 'ACTIVE',
          operation: 'STATUS_QUERY',
        }),
        persistCredentialDenial: (input) => persistCredentialUseDenial(prisma, input),
        persistPolicyDecision: (input) => persistProviderPolicyDecision(prisma, input),
        persistSlaEscalation: (input) => persistSlaEscalation(prisma, input),
        listUnresolvedAttempts: () => prisma.paymentAttempt.findMany({
          where: { obligationId, merchantId, resolvedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      });

      assert.deepEqual(await worker.runOnce(), [{ kind: 'NOT_DUE' }]);
      clock.advanceBy(policy.slaMs);
      assert.deepEqual(await worker.runOnce(), [{
        kind: 'OBSERVATION_INGESTED',
        observationId: namespace.id('observation_worker_integration'),
      }]);

      const persisted = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      assert.equal(persisted.outcomeStatus, 'UNKNOWN');
      assert.equal(persisted.reviewStatus, 'REQUIRED');
      assert.equal(persisted.resolvedAt, null);
      assert.equal(persisted.lastObservationAt?.getTime(), policy.slaMs);
      assert.deepEqual(
        await prisma.paymentOutcomeTransition.count({ where: { attemptId } }),
        1,
      );
      assert.deepEqual(
        await prisma.reconciliationReviewHistory.count({ where: { attemptId } }),
        1,
      );
      const policyAudits = await prisma.providerPolicyDecisionAudit.findMany({
        where: { merchantId, attemptId },
        orderBy: [{ evaluatedAt: 'asc' }, { id: 'asc' }],
      });
      assert.deepEqual(policyAudits.map((row) => row.decision), ['NO_EXECUTION', 'ENABLED']);
      assert.ok(policyAudits.every((row) =>
        row.provider === 'MOCK' &&
        row.environment === 'TEST' &&
        row.operation === 'STATUS_QUERY' &&
        row.policyVersion === policy.version &&
        row.approvedAt !== null &&
        row.effectiveFrom !== null &&
        row.effectiveUntil !== null &&
        row.timing !== null,
      ));
    });

    it('durably fails closed on credential denial while preserving the provider lock', async () => {
      const merchantId = namespace.id('merchant_credential_denial');
      const obligationId = namespace.id('obligation_credential_denial');
      const attemptId = namespace.id('attempt_credential_denial');
      const credentialBindingId = namespace.id('binding_credential_denial');
      const obligation = await prisma.paymentObligation.create({
        data: {
          id: obligationId,
          merchantId,
          checkoutId: namespace.id('checkout_credential_denial'),
          collectionRail: 'ONLINE',
          purpose: 'FULL_ONLINE',
          amountPaise: 10_000n,
          currency: 'INR',
          status: 'OPEN',
          satisfiedAt: null,
        },
      });
      await prisma.paymentAttempt.create({
        data: {
          id: attemptId,
          obligationId,
          merchantId,
          obligationCollectionRail: obligation.collectionRail,
          provider: 'MOCK',
          environment: 'TEST',
          credentialBindingId,
          credentialVersionId: namespace.id('credential_version_denied'),
          requestIdempotencyKey: namespace.id('request_credential_denied'),
          providerOrderRef: mockProviderOrderRef(obligationId, attemptId),
          outcomeStatus: 'PENDING',
          reviewStatus: 'NOT_REQUIRED',
          resolvedAt: null,
          lastOutcomeChangedAt: new Date(0),
          lastObservationAt: null,
          adapterVersion: mockAdapter.adapterVersion,
          mappingVersion: mockAdapter.mappingVersion,
        },
      });

      await persistCredentialUseDenial(prisma, {
        merchantId,
        obligationId,
        attemptId,
        observedAt: new Date(1_000),
        reason: 'CREDENTIAL_NOT_ACTIVE',
        forceUnknownIfUnresolved: true,
        requireReview: true,
        preserveProviderLock: true,
        securityAlert: true,
      });

      assert.partialDeepStrictEqual(
        await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } }),
        {
          provider: 'MOCK',
          environment: 'TEST',
          credentialBindingId,
          outcomeStatus: 'UNKNOWN',
          reviewStatus: 'REQUIRED',
          resolvedAt: null,
        },
      );
      assert.partialDeepStrictEqual(
        await prisma.paymentAttentionSignal.findFirstOrThrow({
          where: { merchantId, obligationId, attemptId, signalCode: 'CREDENTIAL_SECURITY_ALERT' },
        }),
        { observationId: null },
      );
    });

    it('consumes a durable read-only query request from review history and uses explicit credential policy input without changing payment state', async () => {
      const clock = virtualClock(0);
      const merchantId = namespace.id('merchant_worker_manual_request');
      const policy = createMockReconciliationPolicy(merchantId);
      const obligationId = namespace.id('obligation_worker_manual_request');
      const attemptId = namespace.id('attempt_worker_manual_request');
      const obligation = await prisma.paymentObligation.create({
        data: {
          id: obligationId,
          merchantId,
          checkoutId: namespace.id('checkout_worker_manual_request'),
          collectionRail: 'ONLINE',
          purpose: 'FULL_ONLINE',
          amountPaise: 10_000n,
          currency: 'INR',
          status: 'OPEN',
          satisfiedAt: null,
        },
      });
      await prisma.paymentAttempt.create({
        data: {
          id: attemptId,
          obligationId: obligation.id,
          merchantId,
          obligationCollectionRail: obligation.collectionRail,
          provider: 'MOCK',
          environment: 'TEST',
          credentialBindingId: namespace.id('binding_worker_manual_request'),
          credentialVersionId: namespace.id('credential_worker_manual_request'),
          requestIdempotencyKey: namespace.id('request_worker_manual_request'),
          providerOrderRef: mockProviderOrderRef(obligationId, attemptId),
          outcomeStatus: 'PENDING',
          reviewStatus: 'REQUIRED',
          resolvedAt: null,
          lastOutcomeChangedAt: new Date(0),
          lastObservationAt: null,
          adapterVersion: 'mock-adapter-v1',
          mappingVersion: 'mock-mapping-v1',
          createdAt: new Date(0),
        },
      });

      await claimReview(prisma, {
        merchantId,
        attemptId,
        reviewerId: 'admin_1',
      });
      const request = await requestReadOnlyQuery(prisma, {
        merchantId,
        attemptId,
        reviewerId: 'admin_1',
        note: 'await reconciler pass',
        requestId: 'review_query_manual_request',
      });
      let seenCredentialInput: Awaited<ReturnType<CredentialUseInputResolver>> | null = null;

      const worker = reconciliationWorker({
        clock,
        policy,
        getReconciliationState: async (): Promise<DerivedReconciliationState> => {
          const observations = await prisma.providerObservation.findMany({
            where: { attemptId },
            orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
            select: { receivedAt: true },
          });
          return {
            amountPaise: obligation.amountPaise,
            currency: obligation.currency as 'INR',
            queryCount: observations.length,
            lastReconciledAt: observations[0]?.receivedAt ?? null,
          };
        },
        buildCredentialUseInput: async (attempt) => {
          seenCredentialInput = {
            originalMerchantId: attempt.merchantId,
            requestedMerchantId: attempt.merchantId,
            originalProvider: attempt.provider,
            requestedProvider: attempt.provider,
            originalEnvironment: attempt.environment,
            requestedEnvironment: attempt.environment,
            originalBindingId: attempt.credentialBindingId,
            requestedBindingId: attempt.credentialBindingId,
            continuity: 'PROVEN_SAME_ACCOUNT',
            credentialState: 'ACTIVE',
            operation: 'STATUS_QUERY',
          };
          return seenCredentialInput;
        },
        queryStatus: async (input: MockStatusQueryInput) => {
          const raw = await mockAdapter.queryStatus({ ...input, scenario: 'PENDING' });
          return { ...raw, receivedAt: clock.now() };
        },
        ingestRawObservation: (input) => ingestRawObservation({
          parser: mockAdapter,
          ingestionMode: 'MOCK_EXECUTABLE',
          retentionDecision: 'MOCK_SYNTHETIC',
          environment: 'TEST',
          source: 'MOCK',
          securityContext: { merchantId, obligationId, attemptId, credentialBindingId: namespace.id('binding_worker_manual_request') },
          nextObservationId: () => namespace.id('observation_worker_manual_request'),
          resolveBinding: async () => ({
            attemptId,
            obligationId,
            merchantId,
            credentialBindingId: namespace.id('binding_worker_manual_request'),
            credentialVersionId: namespace.id('credential_worker_manual_request'),
            bindingVerification: 'VERIFIED' as const,
          }),
          verify: async () => 'NOT_APPLICABLE' as const,
          persistSecurityRejection: (evidence) => persistProviderSecurityRejection(prisma, evidence),
          persist: (candidate) => ingestObservation(prisma, candidate),
        }, input),
        persistCredentialDenial: (input) => persistCredentialUseDenial(prisma, input),
        persistPolicyDecision: (input) => persistProviderPolicyDecision(prisma, input),
        persistSlaEscalation: (input) => persistSlaEscalation(prisma, input),
        listRequestedReadOnlyQueries: listPendingReadOnlyQueryRequests,
        claimReadOnlyQueryRequest,
        persistReadOnlyQueryConsumption,
        listUnresolvedAttempts: () => prisma.paymentAttempt.findMany({
          where: { obligationId, merchantId, resolvedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      });

      assert.deepEqual(await worker.runOnce(), [{
        kind: 'OBSERVATION_INGESTED',
        observationId: namespace.id('observation_worker_manual_request'),
      }]);

      assert.deepEqual(seenCredentialInput, {
        originalMerchantId: merchantId,
        requestedMerchantId: merchantId,
        originalProvider: 'MOCK',
        requestedProvider: 'MOCK',
        originalEnvironment: 'TEST',
        requestedEnvironment: 'TEST',
        originalBindingId: namespace.id('binding_worker_manual_request'),
        requestedBindingId: namespace.id('binding_worker_manual_request'),
        continuity: 'PROVEN_SAME_ACCOUNT',
        credentialState: 'ACTIVE',
        operation: 'STATUS_QUERY',
      });

      const persisted = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      assert.equal(persisted.outcomeStatus, 'PENDING');
      assert.equal(persisted.reviewStatus, 'IN_PROGRESS');
      assert.equal(persisted.resolvedAt, null);

      const history = await prisma.reconciliationReviewHistory.findMany({
        where: { attemptId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          reasonCode: true,
          correlationId: true,
          evidenceReferenceIds: true,
        },
      });
      assert.deepEqual(history.map((entry) => entry.reasonCode), [
        'REVIEW_CLAIMED',
        'READ_ONLY_QUERY_REQUESTED',
        'READ_ONLY_QUERY_CLAIMED',
        'READ_ONLY_QUERY_CONSUMED',
      ]);
      assert.equal(history[1]?.correlationId, request.requestId);
      assert.deepEqual(history[1]?.evidenceReferenceIds, {
        references: [],
        note: 'await reconciler pass',
      });
      assert.equal(history[2]?.correlationId, request.requestId);
      assert.deepEqual(history[2]?.evidenceReferenceIds, {
        references: [],
        note: 'await reconciler pass',
      });
      assert.equal(history[3]?.correlationId, request.requestId);
      assert.deepEqual(history[3]?.evidenceReferenceIds, {
        references: [],
        note: 'await reconciler pass',
        result: 'OBSERVATION_INGESTED',
      });

      assert.equal((await listPendingReadOnlyQueryRequests()).length, 0);
    });

    it('atomically claims durable read-only query requests so concurrent workers execute exactly one query', async () => {
      const clock = virtualClock(0);
      const merchantId = namespace.id('merchant_worker_manual_request_race');
      const policy = createMockReconciliationPolicy(merchantId);
      const obligationId = namespace.id('obligation_worker_manual_request_race');
      const attemptId = namespace.id('attempt_worker_manual_request_race');
      const obligation = await prisma.paymentObligation.create({
        data: {
          id: obligationId,
          merchantId,
          checkoutId: namespace.id('checkout_worker_manual_request_race'),
          collectionRail: 'ONLINE',
          purpose: 'FULL_ONLINE',
          amountPaise: 10_000n,
          currency: 'INR',
          status: 'OPEN',
          satisfiedAt: null,
        },
      });
      await prisma.paymentAttempt.create({
        data: {
          id: attemptId,
          obligationId: obligation.id,
          merchantId,
          obligationCollectionRail: obligation.collectionRail,
          provider: 'MOCK',
          environment: 'TEST',
          credentialBindingId: namespace.id('binding_worker_manual_request_race'),
          credentialVersionId: namespace.id('credential_worker_manual_request_race'),
          requestIdempotencyKey: namespace.id('request_worker_manual_request_race'),
          providerOrderRef: mockProviderOrderRef(obligationId, attemptId),
          outcomeStatus: 'PENDING',
          reviewStatus: 'REQUIRED',
          resolvedAt: null,
          lastOutcomeChangedAt: new Date(0),
          lastObservationAt: null,
          adapterVersion: 'mock-adapter-v1',
          mappingVersion: 'mock-mapping-v1',
          createdAt: new Date(0),
        },
      });

      await claimReview(prisma, {
        merchantId,
        attemptId,
        reviewerId: 'admin_1',
      });
      const request = await requestReadOnlyQuery(prisma, {
        merchantId,
        attemptId,
        reviewerId: 'admin_1',
        note: 'await single worker claim',
        requestId: 'review_query_manual_request_race',
      });

      let coordinatedListCalls = 0;
      let releaseListBarrier!: () => void;
      const listBarrier = new Promise<void>((resolve) => {
        releaseListBarrier = resolve;
      });
      let queryExecutions = 0;
      let releaseQueryBarrier!: () => void;
      const queryBarrier = new Promise<void>((resolve) => {
        releaseQueryBarrier = resolve;
      });
      let queryStartedResolve!: () => void;
      const queryStarted = new Promise<void>((resolve) => {
        queryStartedResolve = resolve;
      });

      const worker = reconciliationWorker({
        clock,
        policy,
        getReconciliationState: async (): Promise<DerivedReconciliationState> => {
          const observations = await prisma.providerObservation.findMany({
            where: { attemptId },
            orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
            select: { receivedAt: true },
          });
          return {
            amountPaise: obligation.amountPaise,
            currency: obligation.currency as 'INR',
            queryCount: observations.length,
            lastReconciledAt: observations[0]?.receivedAt ?? null,
          };
        },
        buildCredentialUseInput: async (attempt) => ({
          originalMerchantId: attempt.merchantId,
          requestedMerchantId: attempt.merchantId,
          originalProvider: attempt.provider,
          requestedProvider: attempt.provider,
          originalEnvironment: attempt.environment,
          requestedEnvironment: attempt.environment,
          originalBindingId: attempt.credentialBindingId,
          requestedBindingId: attempt.credentialBindingId,
          continuity: 'PROVEN_SAME_ACCOUNT',
          credentialState: 'ACTIVE',
          operation: 'STATUS_QUERY',
        }),
        queryStatus: async (input: MockStatusQueryInput) => {
          queryExecutions += 1;
          queryStartedResolve();
          await queryBarrier;
          const raw = await mockAdapter.queryStatus({ ...input, scenario: 'PENDING' });
          return { ...raw, receivedAt: clock.now() };
        },
        ingestRawObservation: (input) => ingestRawObservation({
          parser: mockAdapter,
          ingestionMode: 'MOCK_EXECUTABLE',
          retentionDecision: 'MOCK_SYNTHETIC',
          environment: 'TEST',
          source: 'MOCK',
          securityContext: { merchantId, obligationId, attemptId, credentialBindingId: namespace.id('binding_worker_manual_request_race') },
          nextObservationId: () => namespace.id('observation_worker_manual_request_race'),
          resolveBinding: async () => ({
            attemptId,
            obligationId,
            merchantId,
            credentialBindingId: namespace.id('binding_worker_manual_request_race'),
            credentialVersionId: namespace.id('credential_worker_manual_request_race'),
            bindingVerification: 'VERIFIED' as const,
          }),
          verify: async () => 'NOT_APPLICABLE' as const,
          persistSecurityRejection: (evidence) => persistProviderSecurityRejection(prisma, evidence),
          persist: (candidate) => ingestObservation(prisma, candidate),
        }, input),
        persistCredentialDenial: (input) => persistCredentialUseDenial(prisma, input),
        persistPolicyDecision: (input) => persistProviderPolicyDecision(prisma, input),
        persistSlaEscalation: (input) => persistSlaEscalation(prisma, input),
        listRequestedReadOnlyQueries: async () => {
          coordinatedListCalls += 1;
          if (coordinatedListCalls === 1) {
            await listBarrier;
          } else {
            releaseListBarrier();
          }
          return listPendingReadOnlyQueryRequests();
        },
        claimReadOnlyQueryRequest,
        persistReadOnlyQueryConsumption,
        listUnresolvedAttempts: () => prisma.paymentAttempt.findMany({
          where: { obligationId, merchantId, resolvedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      });

      const firstRun = worker.runOnce();
      const secondRun = worker.runOnce();
      await queryStarted;
      releaseQueryBarrier();

      const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
      const results = [firstResult, secondResult].flat();

      assert.equal(queryExecutions, 1);
      assert.equal(results.filter((result) =>
        result.kind === 'OBSERVATION_INGESTED' &&
        result.observationId === namespace.id('observation_worker_manual_request_race'),
      ).length, 1);
      assert.equal(results.filter((result) =>
        result.kind === 'QUERY_BLOCKED' &&
        result.reason === 'READ_ONLY_QUERY_ALREADY_CLAIMED',
      ).length, 1);

      const persisted = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      assert.equal(persisted.outcomeStatus, 'PENDING');
      assert.equal(persisted.reviewStatus, 'IN_PROGRESS');
      assert.equal(persisted.resolvedAt, null);

      const history = await prisma.reconciliationReviewHistory.findMany({
        where: { attemptId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          reasonCode: true,
          correlationId: true,
        },
      });
      assert.deepEqual(history.map((entry) => entry.reasonCode), [
        'REVIEW_CLAIMED',
        'READ_ONLY_QUERY_REQUESTED',
        'READ_ONLY_QUERY_CLAIMED',
        'READ_ONLY_QUERY_CONSUMED',
      ]);
      assert.equal(history.filter((entry) => entry.reasonCode === 'READ_ONLY_QUERY_CLAIMED').length, 1);
      assert.equal(history.filter((entry) => entry.reasonCode === 'READ_ONLY_QUERY_CONSUMED').length, 1);
      assert.equal(history[1]?.correlationId, request.requestId);
      assert.equal(history[2]?.correlationId, request.requestId);
      assert.equal(history[3]?.correlationId, request.requestId);
      assert.equal((await listPendingReadOnlyQueryRequests()).length, 0);
    });
  });
}
