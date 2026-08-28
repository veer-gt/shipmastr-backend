import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { ingestObservation, persistSlaEscalation } from '../observationService.js';
import { ingestRawObservation } from '../observationIngestor.js';
import {
  MOCK_RECONCILIATION_POLICY_V1,
  reconciliationWorker,
  type Clock,
  type DerivedReconciliationState,
} from '../reconciliationWorker.js';
import { mockAdapter } from '../adapters/mockAdapter.js';
import type { MockStatusQueryInput } from '../adapters/providerAdapter.js';
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
        decideCredentialUse: () => ({ allowed: true as const, operation: 'STATUS_QUERY' as const }),
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
  });
}
