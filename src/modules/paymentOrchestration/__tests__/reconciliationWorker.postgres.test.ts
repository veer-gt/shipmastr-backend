import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { ingestObservation, persistSlaEscalation } from '../observationService.js';
import { ingestRawObservation } from '../observationIngestor.js';
import {
  MOCK_RECONCILIATION_POLICY_V1,
  reconciliationWorker,
  type CredentialUseInputResolver,
  type Clock,
  type DerivedReconciliationState,
  type PendingReadOnlyQueryRequest,
  type ReadOnlyQueryConsumptionRecord,
} from '../reconciliationWorker.js';
import { mockAdapter } from '../adapters/mockAdapter.js';
import type { MockStatusQueryInput } from '../adapters/providerAdapter.js';
import { claimReview, requestReadOnlyQuery } from '../reviewService.js';
import { expectedScratchDatabaseNameFromEnv } from './scratchDatabaseGuard.js';

const enabled = process.env.RUN_PGO1_POSTGRES_TESTS === '1';
const prisma = new PrismaClient();

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

async function clearPaymentTables() {
  await prisma.providerObservationInterpretation.deleteMany();
  await prisma.providerObservationDelivery.deleteMany();
  await prisma.paymentNormalizedFactOutbox.deleteMany();
  await prisma.refundDueCase.deleteMany();
  await prisma.paymentAttentionSignal.deleteMany();
  await prisma.reconciliationReviewHistory.deleteMany();
  await prisma.paymentOutcomeTransition.deleteMany();
  await prisma.providerObservation.deleteMany();
  await prisma.paymentAttempt.deleteMany();
  await prisma.paymentObligation.deleteMany();
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
    where: { reasonCode: 'READ_ONLY_QUERY_REQUESTED' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const pending: PendingReadOnlyQueryRequest[] = [];
  for (const row of rows) {
    if (!row.correlationId) {
      continue;
    }

    const consumed = await prisma.reconciliationReviewHistory.findFirst({
      where: {
        attemptId: row.attemptId,
        merchantId: row.merchantId,
        reasonCode: 'READ_ONLY_QUERY_CONSUMED',
        correlationId: row.correlationId,
      },
      select: { id: true },
    });
    if (consumed) {
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
      await clearPaymentTables();
    });

    after(async () => {
      await prisma.$disconnect();
    });

    it('uses the persisted attempt shape and routes worker SLA escalation through Task 5 persistence', async () => {
      const clock = virtualClock(0);
      const merchantId = 'merchant_worker_integration';
      const obligationId = 'obligation_worker_integration';
      const attemptId = 'attempt_worker_integration';
      const obligation = await prisma.paymentObligation.create({
        data: {
          id: obligationId,
          merchantId,
          checkoutId: 'checkout_worker_integration',
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
          credentialBindingId: 'binding_worker_integration',
          credentialVersionId: 'credential_worker_integration',
          requestIdempotencyKey: 'request_worker_integration',
          providerOrderRef: 'mock_order_obligation_worker_integration_attempt_worker_integration',
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
        policy: MOCK_RECONCILIATION_POLICY_V1,
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
          nextObservationId: () => 'observation_worker_integration',
          resolveBinding: async () => ({
            attemptId,
            obligationId,
            merchantId,
            credentialBindingId: 'binding_worker_integration',
            credentialVersionId: 'credential_worker_integration',
            bindingVerification: 'VERIFIED' as const,
          }),
          verify: async () => 'NOT_APPLICABLE' as const,
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
        persistSlaEscalation: (input) => persistSlaEscalation(prisma, input),
        listUnresolvedAttempts: () => prisma.paymentAttempt.findMany({
          where: { obligationId, merchantId, resolvedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      });

      assert.deepEqual(await worker.runOnce(), [{ kind: 'NOT_DUE' }]);
      clock.advanceBy(MOCK_RECONCILIATION_POLICY_V1.slaMs);
      assert.deepEqual(await worker.runOnce(), [{
        kind: 'OBSERVATION_INGESTED',
        observationId: 'observation_worker_integration',
      }]);

      const persisted = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      assert.equal(persisted.outcomeStatus, 'UNKNOWN');
      assert.equal(persisted.reviewStatus, 'REQUIRED');
      assert.equal(persisted.resolvedAt, null);
      assert.equal(persisted.lastObservationAt?.getTime(), MOCK_RECONCILIATION_POLICY_V1.slaMs);
      assert.deepEqual(
        await prisma.paymentOutcomeTransition.count({ where: { attemptId } }),
        1,
      );
      assert.deepEqual(
        await prisma.reconciliationReviewHistory.count({ where: { attemptId } }),
        1,
      );
    });

    it('consumes a durable read-only query request from review history and uses explicit credential policy input without changing payment state', async () => {
      const clock = virtualClock(0);
      const merchantId = 'merchant_worker_manual_request';
      const obligationId = 'obligation_worker_manual_request';
      const attemptId = 'attempt_worker_manual_request';
      const obligation = await prisma.paymentObligation.create({
        data: {
          id: obligationId,
          merchantId,
          checkoutId: 'checkout_worker_manual_request',
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
          credentialBindingId: 'binding_worker_manual_request',
          credentialVersionId: 'credential_worker_manual_request',
          requestIdempotencyKey: 'request_worker_manual_request',
          providerOrderRef: 'mock_order_obligation_worker_manual_request_attempt_worker_manual_request',
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
        policy: MOCK_RECONCILIATION_POLICY_V1,
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
          nextObservationId: () => 'observation_worker_manual_request',
          resolveBinding: async () => ({
            attemptId,
            obligationId,
            merchantId,
            credentialBindingId: 'binding_worker_manual_request',
            credentialVersionId: 'credential_worker_manual_request',
            bindingVerification: 'VERIFIED' as const,
          }),
          verify: async () => 'NOT_APPLICABLE' as const,
          persist: (candidate) => ingestObservation(prisma, candidate),
        }, input),
        persistSlaEscalation: (input) => persistSlaEscalation(prisma, input),
        listRequestedReadOnlyQueries: listPendingReadOnlyQueryRequests,
        persistReadOnlyQueryConsumption,
        listUnresolvedAttempts: () => prisma.paymentAttempt.findMany({
          where: { obligationId, merchantId, resolvedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      });

      assert.deepEqual(await worker.runOnce(), [{
        kind: 'OBSERVATION_INGESTED',
        observationId: 'observation_worker_manual_request',
      }]);

      assert.deepEqual(seenCredentialInput, {
        originalMerchantId: merchantId,
        requestedMerchantId: merchantId,
        originalProvider: 'MOCK',
        requestedProvider: 'MOCK',
        originalEnvironment: 'TEST',
        requestedEnvironment: 'TEST',
        originalBindingId: 'binding_worker_manual_request',
        requestedBindingId: 'binding_worker_manual_request',
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
        result: 'OBSERVATION_INGESTED',
      });

      assert.equal((await listPendingReadOnlyQueryRequests()).length, 0);
    });
  });
}
